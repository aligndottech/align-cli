import chalk from 'chalk';
import { BRAND } from '../../brand.js';

/** Align's colours for the agent screen. Pure string styling, so cards stay testable as text. */
export const theme = {
  brand: (s: string): string => chalk.hex(BRAND.teal).bold(s),
  dim: (s: string): string => chalk.dim(s),
  title: (s: string): string => chalk.bold(s),
  warn: (s: string): string => chalk.yellow(s),
  link: (s: string): string => chalk.hex(BRAND.teal).underline(s),
  key: (s: string): string => chalk.hex(BRAND.teal)(s),
  error: (s: string): string => chalk.red(s),
};
