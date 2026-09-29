export const OPENCODE_VERSION = '1.18.31';

function runtimeOs(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'darwin';
    default:
      return process.platform;
  }
}

function runtimeArch(): string {
  switch (process.arch) {
    case 'x64':
      return 'amd64';
    case 'ia32':
      return '386';
    default:
      return process.arch;
  }
}

export function openCodeUserAgent(): string {
  return `opencode/${OPENCODE_VERSION} (${runtimeOs()} ${runtimeArch()}; node${process.versions.node})`;
}

export const OPENCODE_CLIENT_HEADERS: Record<string, string> = {
  'x-opencode-client': 'cli',
};
