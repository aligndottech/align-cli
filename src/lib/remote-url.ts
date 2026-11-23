/** GitHub/GitLab web base parsed from a remote, or null for anything else (bitbucket,
 *  self-hosted, no remote). The one reader of a remote: buildCommitUrl and buildBlobUrl build
 *  links from it and repoFromRemoteUrl names the repo from it, so a link and the repo it is
 *  filed under can't drift on what counts as "a known host" (code-style.md, two writers of one
 *  fact). Its own module because tests mock lib/git.js whole. */
export function repoWebBase(remoteUrl: string | null): { kind: 'github' | 'gitlab'; base: string } | null {
  if (!remoteUrl) return null;
  // A URL-form remote can name a port, and GitHub's documented SSH-over-HTTPS-port remote does:
  // ssh://git@ssh.github.com:443/owner/repo.git. Read with the port in, the "repo" became
  // github.com/443/owner/repo. An scp-form remote (git@github.com:owner/repo) has no port, so
  // only the URL form is touched, and an all-digit owner there stays an owner.
  const url = remoteUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]*?):\d+(?=\/)/i, '$1');
  const gh = url.match(/github\.com[:/](.+?)(?:\.git)?\/?$/i);
  if (gh) return { kind: 'github', base: `https://github.com/${gh[1]}` };
  const gl = url.match(/gitlab\.com[:/](.+?)(?:\.git)?\/?$/i);
  if (gl) return { kind: 'gitlab', base: `https://gitlab.com/${gl[1]}` };
  return null;
}
