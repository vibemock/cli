export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const defaultIO: CliIO = {
  stdout: (line: string) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line: string) => {
    process.stderr.write(`${line}\n`);
  },
};

export function printJson(data: unknown, io: CliIO = defaultIO): void {
  io.stdout(JSON.stringify(data, null, 2));
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, idx) =>
    Math.max(h.length, ...rows.map((r) => (r[idx] ?? '').length)),
  );
  const padRow = (cols: string[]) =>
    cols.map((col, idx) => col.padEnd(widths[idx] ?? 0)).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [padRow(headers), sep, ...rows.map(padRow)].join('\n');
}
