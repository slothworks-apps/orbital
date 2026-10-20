import { describe, expect, it } from 'vitest';
import { HELLO_OS_VERSION_MAX_CHARS } from '@orbital/shared/remote/messages';
import { macOsVersion, parseOsRelease, readOsVersion } from '../src/remote/osVersion.js';
import { serverHello } from '../src/remote/identity.js';

const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
`;

const DEBIAN = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
ID=debian
`;

describe('parseOsRelease', () => {
  it('reads NAME and VERSION_ID, quoted or not', () => {
    expect(parseOsRelease(UBUNTU)).toBe('Ubuntu 24.04');
    expect(parseOsRelease('NAME=Fedora\nVERSION_ID=40\n')).toBe('Fedora 40');
    expect(parseOsRelease("NAME='Rocky Linux'\r\nVERSION_ID='9.4'\r\n")).toBe('Rocky Linux 9.4');
  });

  it('drops Debian\'s GNU/Linux', () => {
    expect(parseOsRelease(DEBIAN)).toBe('Debian 12');
  });

  it('gives the name alone without a version, and nothing without a name', () => {
    expect(parseOsRelease('NAME="Arch Linux"\nID=arch\n')).toBe('Arch Linux');
    expect(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\n')).toBeNull();
    expect(parseOsRelease('')).toBeNull();
    expect(parseOsRelease('NAME=""\n')).toBeNull();
  });

  it('ignores comments, keeps the first of a repeated key, undoes escapes and cuts a long name', () => {
    expect(parseOsRelease('# NAME=Nope\nNAME=Ubuntu\nNAME=Other\nVERSION_ID=24.04\n')).toBe('Ubuntu 24.04');
    expect(parseOsRelease('NAME="My \\"Distro\\""\n')).toBe('My "Distro"');
    expect(parseOsRelease(`NAME="${'x'.repeat(100)}"\nVERSION_ID=1\n`)).toHaveLength(HELLO_OS_VERSION_MAX_CHARS);
  });

  it('refuses a control character, leaving the version out or the name unknown', () => {
    expect(parseOsRelease('NAME=Ubuntu\nVERSION_ID="24.04\u001b[31m"\n')).toBe('Ubuntu');
    expect(parseOsRelease('NAME="Ubu\u0007ntu"\nVERSION_ID=24.04\n')).toBeNull();
  });
});

describe('macOsVersion', () => {
  it('words sw_vers\' answer, and refuses anything that is not a version', () => {
    expect(macOsVersion('14.6\n')).toBe('macOS 14.6');
    expect(macOsVersion('15.1.1')).toBe('macOS 15.1.1');
    expect(macOsVersion('26')).toBe('macOS 26');
    expect(macOsVersion('')).toBeNull();
    expect(macOsVersion('14.6 beta')).toBeNull();
  });
});

describe('readOsVersion', () => {
  const readers = (o: { sw?: string | Error; files?: Record<string, string> }) => ({
    swVers: async () => {
      if (o.sw instanceof Error || o.sw === undefined) throw o.sw ?? new Error('none');
      return o.sw;
    },
    osRelease: async (file: string) => {
      const text = o.files?.[file];
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
  });

  it('asks sw_vers on a Mac and the os-release files on Linux, the second when the first is missing', async () => {
    expect(await readOsVersion('darwin', readers({ sw: '14.6' }))).toBe('macOS 14.6');
    expect(await readOsVersion('linux', readers({ files: { '/etc/os-release': UBUNTU } }))).toBe('Ubuntu 24.04');
    expect(await readOsVersion('linux', readers({ files: { '/usr/lib/os-release': DEBIAN } }))).toBe('Debian 12');
  });

  it('is unknown when nothing answers, and on any other platform', async () => {
    expect(await readOsVersion('darwin', readers({ sw: new Error('timeout') }))).toBeNull();
    expect(await readOsVersion('linux', readers({}))).toBeNull();
    expect(await readOsVersion('win32', readers({ sw: '14.6' }))).toBeNull();
  });
});

describe('serverHello', () => {
  it('names the OS version when it is known, and leaves the field out when not', () => {
    expect(serverHello({ serverVersion: '0.35.0', name: 'nuc', kind: 'headless', osVersion: 'Ubuntu 24.04' }).osVersion).toBe('Ubuntu 24.04');
    expect(serverHello({ serverVersion: '0.35.0', name: 'nuc', kind: 'headless', osVersion: null })).not.toHaveProperty('osVersion');
  });
});
