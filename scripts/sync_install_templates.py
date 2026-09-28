#!/usr/bin/env python3
"""Keep the installers in step with the files they install.

scripts/install.sh and scripts/install.ps1 both carry the hooks, the settings files and the
/cs and /ce commands as inline here-documents. The copies under .claude/ and .gemini/ are the
ones this repo actually runs, so those get fixed and the embedded ones do not: when this was
written every single embedded artefact had drifted, and running the installer would have
downgraded the enforcement hooks by three versions — no discovery gate at all in the gemini
variants, and cortex_quality_report alone unlocking commits.

    sync_install_templates.py           write the canonical files into both installers
    sync_install_templates.py --check   report drift and exit 1 (for CI)
"""
import re
import sys

CHECK = '--check' in sys.argv[1:]
INSTALLER_SH = 'scripts/install.sh'
INSTALLER_PS1 = 'scripts/install.ps1'
REPO_URL = 'https://github.com/lktiep/cortex-hub.git'

# Files the installers write, and where the canonical version lives.
TARGETS = [
    '.claude/hooks/session-init.sh',
    '.claude/hooks/enforce-session.sh',
    '.claude/hooks/enforce-commit.sh',
    '.claude/hooks/track-quality.sh',
    '.claude/hooks/session-end-check.sh',
    '.claude/settings.json',
    '.claude/commands/cs.md',
    '.claude/commands/ce.md',
    '.gemini/hooks/session-init.sh',
    '.gemini/hooks/enforce-session.sh',
    '.gemini/hooks/enforce-commit.sh',
    '.gemini/hooks/track-quality.sh',
    '.gemini/hooks/session-end-check.sh',
    '.gemini/settings.json',
]
# This repo's own /cs names this repo. Every other repo gets its own URL substituted in.
PLACEHOLDER = {'.claude/commands/cs.md', '.claude/commands/ce.md'}

# install.ps1 wraps the claude hook commands for Windows, so that one file can never be
# byte-identical between the two installers; it is checked structurally instead.
PS1_SKIP = {'.claude/settings.json'}


def find_sh(src, path):
    """Locate a `cat > <path> << 'DELIM' … DELIM` body. Returns (start, end) or None."""
    m = re.search(r'cat > ' + re.escape(path) + r" << '(\w+)'\n", src)
    if not m:
        return None
    end = src.find('\n' + m.group(1) + '\n', m.end())
    if end == -1:
        return None
    return m.end(), end


def find_ps1(src, path):
    """Locate a PowerShell here-string body.

    The opening `@'` is the same three characters for every here-string in the file, so the
    tail — which names the file being written — is what identifies one. Search for that, then
    walk back to the nearest opener; a lazy regex from the first `@'` would swallow every
    here-string in between.
    """
    name = path.rsplit('/', 1)[1]
    if path.startswith('.claude/hooks/'):
        head = 'Write-ShHook "%s" @\'\n' % name[:-3]
        start = src.find(head)
        if start == -1:
            return None
        body = start + len(head)
        end = src.find("\n'@", body)
        return (body, end) if end != -1 else None

    if path.startswith('.gemini/hooks/'):
        tail = '\n\'@ | Out-File -FilePath "$geminiHooksDir\\%s"' % name
    elif path.startswith('.claude/commands/'):
        tail = '\n\'@ | Out-File -FilePath (Join-Path $cmdDir "%s")' % name
    elif path == '.gemini/settings.json':
        tail = '\n\'@ | Out-File -FilePath ".gemini\\settings.json"'
    else:
        return None

    end = src.find(tail)
    if end == -1:
        return None
    opener = src.rfind("@'\n", 0, end)
    if opener == -1:
        return None
    return opener + 3, end


# ── The rule text the installers write into CLAUDE.md / .cursorrules / .codex / .vscode ──
# This lives in neither .claude/ nor .gemini/: install.sh is the source and install.ps1 has to
# say the same thing, or a Windows install teaches a different workflow from a mac one — which
# is exactly what it did (the ps1 still had the removed STATE.md step and the old tool ladder).
RULE_BLOCKS = [
    # (install.sh extractor, install.ps1 here-string opener, strip the markers?)
    (r"cat << INSTREOF\n(.*?)\nINSTREOF\n", "$instructionContent = @'", False),
    (r"CONTENT=\$\(cat << 'CLAUDEEOF'\n(.*?)\nCLAUDEEOF\n", "$claudeMdBody = @'", True),
]
MARKER = '<!-- cortex-hub:auto-mcp -->'


def rule_text(sh, pattern, strip_markers):
    """The canonical wording from install.sh, with the shell's escaping undone."""
    body = re.search(pattern, sh, re.S).group(1)
    body = body.replace('\\`', '`').replace('$GIT_REPO', '__GIT_REPO__').replace('$agent_id', '__AGENT_ID__')
    if strip_markers:
        # The CLAUDE.md block carries its markers in the shell variable; the ps1 adds them itself.
        # The instruction files keep theirs, so they are only stripped where asked for.
        body = body[body.find(MARKER) + len(MARKER):body.rfind(MARKER)].strip('\n')
    return body


def sync_rules(check, drift, synced):
    sh = open(INSTALLER_SH).read()
    ps1 = open(INSTALLER_PS1).read()
    changed = False
    for pattern, opener, strip_markers in RULE_BLOCKS:
        want = rule_text(sh, pattern, strip_markers)
        start = ps1.index(opener) + len(opener) + 1   # past the newline after @'
        end = ps1.index("\n'@", start)
        have = ps1[start:end]
        if have == want:
            continue
        if check:
            print('  drift %s :: %s: installer has %d lines, install.sh has %d'
                  % (INSTALLER_PS1, opener.split()[0], len(have.splitlines()), len(want.splitlines())))
            drift.append(opener)
        else:
            ps1 = ps1[:start] + want + ps1[end:]
            synced.append('install.sh rule text -> %s (%s)' % (INSTALLER_PS1, opener.split()[0]))
            changed = True
    if changed:
        open(INSTALLER_PS1, 'w').write(ps1)


def main():
    drift, synced = [], []

    for installer, finder in ((INSTALLER_SH, find_sh), (INSTALLER_PS1, find_ps1)):
        src = open(installer).read()
        changed = False
        for path in TARGETS:
            if installer == INSTALLER_PS1 and path in PS1_SKIP:
                continue
            want = open(path).read().rstrip('\n')
            if path in PLACEHOLDER:
                want = want.replace(REPO_URL, '__GIT_REPO__')

            span = finder(src, path)
            if span is None:
                print('  ?? %s :: %s: no here-doc found' % (installer, path))
                drift.append(path)
                continue
            start, end = span
            have = src[start:end]
            if have == want:
                continue
            if CHECK:
                print('  drift %s :: %s: installer has %d lines, the real file has %d'
                      % (installer, path, len(have.splitlines()), len(want.splitlines())))
                drift.append(path)
            else:
                src = src[:start] + want + src[end:]
                synced.append('%s -> %s' % (path, installer))
                changed = True
        if changed:
            open(installer, 'w').write(src)

    sync_rules(CHECK, drift, synced)

    # The structural half of the .claude/settings.json check for install.ps1.
    ps1 = open(INSTALLER_PS1).read()
    for event in ('SessionStart', 'PreToolUse', 'PostToolUse', 'SessionEnd'):
        if '"%s"' % event not in ps1:
            print('  ?? %s: .claude/settings.json is missing the %s hook' % (INSTALLER_PS1, event))
            drift.append('settings:%s' % event)
    # `$ErrorActionPreference = "Stop"` is not a hook registration, so match the JSON key.
    if '"Stop": [' in ps1:
        print('  ?? %s: still registers Stop — session-end-check belongs on SessionEnd, or it '
              'fires after every assistant turn' % INSTALLER_PS1)
        drift.append('settings:Stop')

    if synced:
        for line in synced:
            print('  synced %s' % line)
        print('\n%d file(s) written' % len(synced))
    elif not CHECK:
        print('nothing to sync')

    if drift:
        print('\n%d item(s) out of sync%s' % (len(drift), ' — run scripts/sync-install-templates.sh'
                                              if CHECK else ' — needs a hand, see above'))
        return 1
    if CHECK:
        print('install.sh and install.ps1 match .claude/ and .gemini/ — nothing to sync')
    return 0


if __name__ == '__main__':
    sys.exit(main())
