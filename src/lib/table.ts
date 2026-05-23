import chalk from 'chalk';

export interface Column {
  header: string;
  width: number;
  color?: (v: string) => string;
}

export function renderTable(columns: Column[], rows: string[][]): void {
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);
  const header = columns.map(c => c.header.padEnd(c.width)).join('');
  console.log(chalk.dim(header));
  console.log(chalk.dim('-'.repeat(totalWidth)));
  for (const row of rows) {
    const line = columns.map((c, i) => {
      const val = (row[i] ?? '').slice(0, c.width - 2).padEnd(c.width);
      return c.color ? c.color(val) : chalk.dim(val);
    }).join('');
    console.log(line);
  }
  console.log('');
}
