import { execSync } from 'node:child_process';

try {
  const result = execSync(
    `/opt/homebrew/bin/claude -p 'say hello' --output-format json < /dev/null`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 120000, encoding: 'utf-8' }
  );
  console.log('OK:', result.slice(0, 1000));
} catch (e) {
  console.log('ERR code:', e.status);
  console.log('STDOUT:', e.stdout?.slice(0, 500));
  console.log('STDERR:', e.stderr?.slice(0, 500));
}
