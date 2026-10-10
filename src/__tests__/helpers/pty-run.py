# Run a command on a real pseudo-terminal and type answers when prompts appear.
# argv: <json command> <json steps [[expect, send], ...]>. Prints one JSON line {code, out}.
# The master side stays open until the child exits, so the child's stdin is never at EOF.
import fcntl, json, os, pty, select, struct, sys, termios, time
cmd = json.loads(sys.argv[1]); steps = json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))  # a 0-column window makes prompt libraries print one character per line
buf = b''; pos = 0; si = 0; deadline = time.time() + 50
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            d = os.read(fd, 4096)
        except OSError:
            break
        if not d:
            break
        buf += d
    if si < len(steps):
        i = buf.find(steps[si][0].encode(), pos)
        if i >= 0:
            pos = i + len(steps[si][0]); os.write(fd, steps[si][1].encode()); si += 1
code = None
for _ in range(100):
    p, st = os.waitpid(pid, os.WNOHANG)
    if p:
        code = os.waitstatus_to_exitcode(st); break
    time.sleep(0.1)
if code is None:
    os.kill(pid, 9); code = -9
print(json.dumps({'code': code, 'out': buf.decode('utf8', 'replace')}))
