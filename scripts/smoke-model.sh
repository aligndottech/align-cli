#!/usr/bin/env bash
# Everything the install smoke needs to know about the on-device embedding model: where it
# caches, and how to tell huggingface.co rate-limiting a shared runner IP from a defect of ours.
#
# Sourced, never executed - it only defines functions. Guards: scripts/__tests__/test-smoke-model.sh.
#
# This is a separate, tested file rather than a few greps inside smoke-install.sh because one of
# these functions decides whether a red gate becomes a warning. An untested predicate in that
# position is the ALI-348 shape: a check that reports "fine" because it could not tell.

# True when the text carries huggingface.co refusing a model download with HTTP 429.
#
# Narrow on purpose, in three ways at once, because everything it matches stops failing the
# build: the exact wording transformers.js emits, the exact status, and the host - all on ONE
# line. grep is line-based, so the single-line requirement comes for free and an unrelated 429
# elsewhere in a long log cannot pair up with an unrelated huggingface URL.
#
# The wording is upstream's, from @huggingface/transformers/src/utils/hub/utils.js:
#   const message = ERROR_MAPPING[status] ?? `Error (${status}) occurred while trying to load file`;
#   throw Error(`${message}: "${remoteURL}".`);
# 429 has no ERROR_MAPPING entry, so it takes the generic branch. 404 ("Could not locate file")
# and 503 ("Service unavailable error...") have their own phrases and cannot collide with this.
# If a dependency bump gives 429 its own phrase this stops matching and rate limits go back to
# failing red - the safe direction, and test-smoke-model.sh says so rather than leaving it silent.
is_upstream_model_rate_limit() {
  printf '%s\n' "${1-}" |
    grep -qE 'Error \(429\) occurred while trying to load file: "https://huggingface\.co/'
}

# pass | fail | skip-upstream, for one smoke step that needs the model.
#
# The 429 is read BEFORE the exit code, and that ordering is the point: `align import git`
# exited 0 on the ALI-713 run while reporting "Imported 0 decisions (1 batch failed)", so the
# exit code alone certified an empty graph as a pass. A step whose output carries the upstream
# 429 has not tested anything, whatever it exited with.
classify_step_result() { # <rc> <output>
  local rc="${1-1}" out="${2-}"
  if is_upstream_model_rate_limit "$out"; then
    printf 'skip-upstream\n'
    return 0
  fi
  if [ "$rc" -eq 0 ]; then printf 'pass\n'; else printf 'fail\n'; fi
}

# The installed @huggingface/transformers package root, resolved from <pkg-dir>'s own require
# context - the same resolution the CLI performs at runtime, rather than a node_modules path
# that hoisting would make a guess. Prints nothing and exits non-zero when the optional
# dependency is absent, so a caller cannot end up copying files into an empty path.
#
# It walks up from the resolved entry point because ./package.json is not in the package's
# exports map and therefore cannot be resolved directly.
hf_model_pkg_dir() { # <pkg-dir>
  node -e '
    const { createRequire } = require("node:module");
    const path = require("node:path");
    const fs = require("node:fs");
    const NAME = "@huggingface/transformers";
    const req = createRequire(path.join(process.argv[1], "package.json"));
    let dir = path.dirname(req.resolve(NAME));
    for (;;) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) {
        try {
          if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === NAME) break;
        } catch { /* keep walking */ }
      }
      const up = path.dirname(dir);
      if (up === dir) { console.error(`could not find the ${NAME} package root`); process.exit(1); }
      dir = up;
    }
    process.stdout.write(dir);
  ' "$1"
}

# Where that package caches downloaded model files. ASKED THE LIBRARY (env.cacheDir) rather
# than rebuilding its convention here: transformers.js exposes no environment variable for it,
# so a hardcoded "<pkg>/.cache" would be a second writer of the library's own fact and would
# drift the first time upstream moves it. Prints nothing and exits non-zero on any failure.
hf_model_cache_dir() { # <pkg-dir>
  node --input-type=module -e '
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    import path from "node:path";
    const req = createRequire(path.join(process.argv[1], "package.json"));
    const mod = await import(pathToFileURL(req.resolve("@huggingface/transformers")).href);
    const dir = mod?.env?.cacheDir;
    if (!dir) { console.error("@huggingface/transformers reports no env.cacheDir"); process.exit(1); }
    process.stdout.write(dir);
  ' "$1"
}
