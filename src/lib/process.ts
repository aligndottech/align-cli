import { execa } from 'execa';

export async function isK3dRunning(): Promise<boolean> {
  try {
    const r = await execa('k3d', ['cluster', 'list', '--no-headers']);
    return r.stdout.trim().length > 0;
  } catch { return false; }
}

export async function isDockerRunning(): Promise<boolean> {
  try {
    await execa('docker', ['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch { return false; }
}

export async function isNgrokInstalled(): Promise<boolean> {
  try {
    await execa('ngrok', ['version']);
    return true;
  } catch { return false; }
}

export async function getNgrokTunnelUrl(): Promise<string | null> {
  try {
    const res = await fetch('http://localhost:4040/api/tunnels');
    const data = await res.json() as { tunnels: Array<{ public_url: string; proto: string }> };
    return data.tunnels.find(t => t.proto === 'https')?.public_url ?? null;
  } catch { return null; }
}

export async function streamDockerLogs(containerName: string): Promise<void> {
  await execa('docker', ['logs', containerName, '-f', '--tail', '100'], {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

export async function streamKubectlLogs(connectorKey: string, namespace: string): Promise<void> {
  await execa(
    'kubectl',
    ['logs', '-n', namespace, `-lapp=align-connector-${connectorKey}`, '-f', '--tail=100'],
    { stdout: process.stdout, stderr: process.stderr },
  );
}
