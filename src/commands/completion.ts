import type { Command } from "commander";
import { usageError } from "../errors.js";

export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

interface Node {
  /** Space-separated command path ("" for the root). */
  path: string;
  subcommands: string[];
  flags: string[];
}

/** Every command path with its subcommands and flags, from the commander tree. */
export function commandTree(program: Command): Node[] {
  const out: Node[] = [];
  const walk = (cmd: Command, path: string[]) => {
    const flags = cmd.options.flatMap((o) => [o.short, o.long].filter((f): f is string => Boolean(f)));
    if (path.length === 0) flags.push("--version", "--help");
    else flags.push("--help");
    const subs = cmd.commands.map((c) => c.name());
    out.push({ path: path.join(" "), subcommands: subs, flags: [...new Set(flags)] });
    for (const c of cmd.commands) walk(c, [...path, c.name()]);
  };
  walk(program, []);
  return out;
}

const words = (n: Node) => [...n.subcommands, ...n.flags].join(" ");

function bash(name: string, tree: Node[]): string {
  const cases = tree.map((n) => `    "${n.path}") words="${words(n)}" ;;`).join("\n");
  const subs = tree.filter((n) => n.subcommands.length).map((n) => `    "${n.path}") subs="${n.subcommands.join(" ")}" ;;`).join("\n");
  const fn = `_${name.replace(/-/g, "_")}`;
  return `# ${name} bash completion. Install: ${name} completion bash > ~/.local/share/bash-completion/completions/${name}
${fn}() {
  local cur path="" subs words i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  for ((i = 1; i < COMP_CWORD; i++)); do
    local w="\${COMP_WORDS[i]}"
    [[ "$w" == -* ]] && continue
    subs=""
    case "$path" in
${subs}
    esac
    [[ " $subs " == *" $w "* ]] && path="\${path:+$path }$w"
  done
  case "$path" in
${cases}
    *) words="" ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -o default -F ${fn} ${name}
`;
}

function zsh(name: string, tree: Node[]): string {
  // zsh runs bash completions through bashcompinit; one implementation for both.
  return `#compdef ${name}
# ${name} zsh completion. Install: ${name} completion zsh > "\${fpath[1]}/_${name}" (then restart zsh)
(( $+functions[compdef] )) || { autoload -U +X compinit && compinit; }
autoload -U +X bashcompinit && bashcompinit
${bash(name, tree).split("\n").slice(1).join("\n")}`;
}

function fish(name: string, tree: Node[]): string {
  const lines = [`# ${name} fish completion. Install: ${name} completion fish > ~/.config/fish/completions/${name}.fish`, `complete -c ${name} -f`];
  for (const n of tree) {
    const parts = n.path ? n.path.split(" ") : [];
    const cond =
      parts.length === 0
        ? "__fish_use_subcommand"
        : `__fish_seen_subcommand_from ${parts[parts.length - 1]}${parts.length > 1 ? `; and __fish_seen_subcommand_from ${parts[0]}` : ""}`;
    if (n.subcommands.length) lines.push(`complete -c ${name} -n '${cond}' -a '${n.subcommands.join(" ")}'`);
    for (const f of n.flags) {
      const opt = f.startsWith("--") ? `-l ${f.slice(2)}` : `-s ${f.slice(1)}`;
      lines.push(`complete -c ${name} -n '${cond}' ${opt}`);
    }
  }
  return lines.join("\n") + "\n";
}

function powershell(name: string, tree: Node[]): string {
  const table = tree.map((n) => `    '${n.path}' = @(${[...n.subcommands, ...n.flags].map((w) => `'${w}'`).join(", ")})`).join("\n");
  return `# ${name} PowerShell completion. Install: ${name} completion powershell >> $PROFILE
$__eliteaCliTree = @{
${table}
}
Register-ArgumentCompleter -Native -CommandName '${name}' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $path = ''
  foreach ($el in $commandAst.CommandElements | Select-Object -Skip 1) {
    $w = $el.ToString()
    if ($w -eq $wordToComplete) { break }
    if ($w.StartsWith('-')) { continue }
    $next = if ($path) { "$path $w" } else { $w }
    if ($__eliteaCliTree.ContainsKey($next)) { $path = $next }
  }
  $__eliteaCliTree[$path] | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
}

export function completionScript(shell: string, program: Command): string {
  const tree = commandTree(program);
  const name = program.name();
  switch (shell as Shell) {
    case "bash":
      return bash(name, tree);
    case "zsh":
      return zsh(name, tree);
    case "fish":
      return fish(name, tree);
    case "powershell":
      return powershell(name, tree);
    default:
      throw usageError(`Shell must be one of ${SHELLS.join(", ")}, got "${shell}"`);
  }
}
