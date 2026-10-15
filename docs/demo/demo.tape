# The README demo GIF. Render from the repo root:
#   docker run --rm -v "$PWD/docs/demo:/vhs" ghcr.io/charmbracelet/vhs:v0.9.0 demo.tape
# replay.sh prints text copied from two real runs; the caption in the GIF says so.

Output demo.gif
Set Shell "bash"
Set FontSize 17
Set Width 1180
Set Height 660
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 18ms

Hide
Type "export PS1='$ ' && clear" Enter
Show

Type "# install: npm install -g @aligndottech/cli" Enter
Sleep 600ms
Type "# then, in a git repo: align" Enter
Sleep 900ms
Type "# below: the same prompt, two runs on our own repo, replayed from the real transcripts" Enter
Sleep 1.4s
Hide
Type "./replay.sh cold" Enter
Show
Sleep 8s
Hide
Type "./replay.sh align" Enter
Show
Sleep 9s
