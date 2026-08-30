// Preview every mark style in real colour. Run: node scripts/logo-preview.mjs
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.env.COLORTERM = process.env.COLORTERM || 'truecolor';
const { banner } = await import('../dist/lib/brand.js');
for (const style of ['white', 'teal', 'solid']) {
  console.log(`\n\x1b[1m  ${style}\x1b[0m\n`);
  console.log(banner({ version: '0.25.0', context: 'local graph', style, color: true, truecolor: true }));
}
console.log('');
