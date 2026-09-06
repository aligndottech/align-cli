# For glama.ai's MCP directory listing (ALI-898): their check needs a server that starts
# and answers MCP introspection (initialize + tools/list) over stdio. Installs the published
# npm package rather than building from source, and deliberately unpinned - the point of a
# CLI wrapper like this is to reflect what a fresh `npm install -g @aligndottech/cli` gives a
# real user, not a snapshot frozen at whatever version this file was last touched.
FROM node:22.16-alpine

RUN npm install -g --no-audit --no-fund @aligndottech/cli

USER node
ENV HOME=/home/node

ENTRYPOINT ["align"]
CMD ["mcp"]
