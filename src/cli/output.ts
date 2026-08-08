const useColor =
  process.env['NO_COLOR'] === undefined &&
  process.env['AGENTCTL_NO_COLOR'] === undefined &&
  process.stdout.isTTY === true;

const wrap = (code: string) => (text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

/**
 * `agentctl events | head` closes the pipe while we are still writing, which
 * Node surfaces as an unhandled EPIPE and a stack trace. Downstream hanging up
 * is normal for a CLI, so treat it as a clean exit.
 */
export function installStreamErrorHandlers(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        process.exit(0);
      }
      throw error;
    });
  }
}

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const renderRow = (cells: readonly string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  const lines = [
    style.bold(renderRow(headers)),
    style.dim(widths.map((w) => '─'.repeat(w)).join('  ')),
  ];
  for (const row of rows) lines.push(renderRow(row));
  return lines.join('\n');
}

export function keyValues(pairs: readonly (readonly [string, string])[]): string {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs
    .map(([key, value]) => `${style.dim(`${key}:`.padEnd(width + 1))} ${value}`)
    .join('\n');
}

export function statusIcon(status: 'ok' | 'warn' | 'fail'): string {
  if (status === 'ok') return style.green('✔');
  if (status === 'warn') return style.yellow('!');
  return style.red('✘');
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
