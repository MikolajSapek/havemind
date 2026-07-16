// Pure, I/O-free validation of the hardened Havemind Compose package.
//
// Given the raw text of deploy/compose.yaml and apps/server/Dockerfile it
// returns the list of hardening violations. Consumed by scripts/compose-smoke.mjs
// and by tests/compose/compose-config.test.ts. Kept dependency-free (no YAML
// library) so it runs identically on macOS without Docker and on the sapserver
// host — the authoritative `docker compose config` cross-check lives in the
// smoke runner.

/**
 * @param {{ composeText: string, dockerfileText: string }} input
 * @returns {{ violations: string[] }}
 */
export function analyzeCompose({ composeText, dockerfileText }) {
  const violations = [];

  checkNoAnyAddress(composeText, violations);
  checkPortBindings(composeText, violations);
  checkForbiddenTokens(composeText, violations);
  checkRequiredHardening(composeText, violations);
  checkImagePinning(dockerfileText, violations);

  return { violations };
}

/** No literal public-any address may appear anywhere in the rendered config. */
function checkNoAnyAddress(composeText, violations) {
  const matches = composeText.match(/0\.0\.0\.0/g) ?? [];
  for (let i = 0; i < matches.length; i += 1) {
    violations.push('Found literal 0.0.0.0 in compose configuration');
  }
}

/**
 * Every published host port must bind loopback explicitly. A mapping without a
 * host IP (`8787:8787`) makes Docker bind 0.0.0.0, so it is a violation too.
 */
function checkPortBindings(composeText, violations) {
  for (const mapping of collectPortMappings(composeText)) {
    const hostIp = hostIpOf(mapping);
    if (hostIp === undefined) {
      violations.push(
        `Published port "${mapping}" has no host IP (would bind all interfaces); pin 127.0.0.1`,
      );
    } else if (!isLoopbackIp(hostIp)) {
      violations.push(
        `Published port "${mapping}" binds host IP ${hostIp}; only 127.0.0.1 is allowed`,
      );
    }
  }
}

/** Extract the short-syntax mapping strings under every `ports:` block. */
function collectPortMappings(composeText) {
  const lines = composeText.split('\n');
  const mappings = [];
  let inPorts = false;
  let portsIndent = -1;

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    if (line.trim() === '') {
      continue;
    }
    const indent = line.length - line.trimStart().length;

    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }

    if (inPorts) {
      const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (itemMatch && indent > portsIndent) {
        mappings.push(unquote(itemMatch[1]));
        continue;
      }
      // A non-list line at or below the ports indent closes the block.
      if (indent <= portsIndent) {
        inPorts = false;
      }
    }
  }

  return mappings;
}

/**
 * Return the host IP a mapping binds, or undefined when none is present.
 * Handles `ip:host:container`, `[ipv6]:host:container`, `host:container`,
 * and bare `container`.
 */
function hostIpOf(mapping) {
  const value = mapping.replace(/\/(tcp|udp)$/i, '');

  // Only a leading host-IP prefix counts; port fields may hold ${VAR:-default}
  // interpolation containing their own colons, so we never split on ':'.
  const ipv6 = /^\[([0-9a-fA-F:]+)\]:/.exec(value);
  if (ipv6) {
    return ipv6[1];
  }

  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3}):/.exec(value);
  if (ipv4) {
    return ipv4[1];
  }

  // No recognisable host-IP prefix: `port:container`, bare `container`, or a
  // wildcard bind — all leave Docker publishing on every interface.
  return undefined;
}

function isLoopbackIp(hostIp) {
  return hostIp === '127.0.0.1' || hostIp === '::1';
}

/** Structural anti-patterns that must never appear. */
function checkForbiddenTokens(composeText, violations) {
  if (/^\s*privileged:\s*true\b/m.test(composeText)) {
    violations.push('privileged: true is forbidden');
  }
  if (/^\s*cap_add:/m.test(composeText)) {
    violations.push('cap_add is forbidden (drop all capabilities instead)');
  }
  if (/docker\.sock/.test(composeText)) {
    violations.push('mounting the docker.sock is forbidden');
  }
  if (/^\s*network_mode:\s*["']?host\b/m.test(composeText)) {
    violations.push('network_mode: host is forbidden');
  }
}

/** Required hardening directives (plan/07 Compose contract). */
function checkRequiredHardening(composeText, violations) {
  const requirements = [
    [/^\s*read_only:\s*true\b/m, 'read_only: true is required'],
    [
      /no-new-privileges:\s*["']?true/,
      'security_opt no-new-privileges:true is required',
    ],
    [/^\s*cap_drop:/m, 'cap_drop is required'],
    [/^\s*security_opt:/m, 'security_opt is required'],
    [/^\s*init:\s*true\b/m, 'init: true is required'],
    [/^\s*tmpfs:/m, 'tmpfs is required'],
    [/^\s*restart:/m, 'restart policy is required'],
    [/^\s*healthcheck:/m, 'healthcheck is required'],
    [/^\s*user:\s*["']?[1-9]/m, 'a non-root numeric user is required'],
    [/driver:\s*["']?local\b/, 'logging driver "local" is required'],
    [/max-size:/, 'logging max-size is required'],
  ];

  for (const [pattern, message] of requirements) {
    if (!pattern.test(composeText)) {
      violations.push(message);
    }
  }

  // cap_drop must include ALL.
  if (
    /^\s*cap_drop:/m.test(composeText) &&
    !/cap_drop:\s*(?:\r?\n\s*-\s*["']?ALL\b|\[\s*["']?ALL)/m.test(composeText)
  ) {
    violations.push('cap_drop must drop ALL capabilities');
  }

  // Reject a root user if one is declared.
  const userMatch = /^\s*user:\s*["']?([^"'\s]+)/m.exec(composeText);
  if (userMatch) {
    const uid = userMatch[1].split(':')[0];
    if (uid === '0' || uid === 'root') {
      violations.push('the container must not run as root');
    }
  }
}

/**
 * Every FROM base image must be pinned by @sha256 digest. FROM references to a
 * prior build stage (AS <name>) are exempt; ARG-substituted refs are resolved
 * to their ARG default.
 */
function checkImagePinning(dockerfileText, violations) {
  const lines = dockerfileText.split('\n');
  const args = new Map();
  const stages = new Set();

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    const argMatch = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(line);
    if (argMatch) {
      args.set(argMatch[1], argMatch[2].trim());
      continue;
    }
    const stageMatch = /\bAS\s+([A-Za-z0-9_-]+)\s*$/i.exec(line);
    if (/^FROM\s/i.test(line) && stageMatch) {
      stages.add(stageMatch[1].toLowerCase());
    }
  }

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    const fromMatch = /^FROM\s+(\S+)/i.exec(line);
    if (!fromMatch) {
      continue;
    }
    let ref = fromMatch[1];

    const varMatch = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(ref);
    if (varMatch && args.has(varMatch[1])) {
      ref = args.get(varMatch[1]);
    }

    if (stages.has(ref.toLowerCase())) {
      continue;
    }

    if (!ref.includes('@sha256:')) {
      violations.push(
        `Base image "${ref}" is not pinned by digest (missing @sha256:)`,
      );
    }
  }
}

function stripComment(line) {
  // Remove trailing "# ..." comments while ignoring "#" inside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
