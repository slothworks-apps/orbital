import { describe, it, expect } from 'vitest'
import { managerWords } from '@orbital/shared/remote/groupWords'

// Who will manage the group, as a pairing's screens say it (canvas 50b, 50c,
// 50i): each line only where it is true.

describe('managerWords', () => {
  it('a pairing this device founds the group with: NEW GROUP, the role is new here', () => {
    expect(managerWords({ by: 'here', newGroup: true }, 'imac-home')).toEqual({
      eyebrow: 'JOIN REQUEST · NEW GROUP',
      line: 'This device will manage the group: devices are added and removed here.',
      done: 'A group of two now, managed here. Add more devices from Devices → Add a device.',
    })
  })

  it('a device the primary adds to its group: nothing about the role, which is not new', () => {
    expect(managerWords({ by: 'here', newGroup: false }, 'imac-home')).toEqual({
      eyebrow: 'JOIN REQUEST', line: null, done: null,
    })
  })

  it('the other device founds the group: it will manage it', () => {
    expect(managerWords({ by: 'there', newGroup: true }, 'imac-home')).toEqual({
      eyebrow: 'JOIN REQUEST · NEW GROUP',
      line: 'imac-home will manage the group: devices are added and removed there.',
      done: 'imac-home manages the group: add more devices there.',
    })
  })

  it('the other device is the primary of its group already: it manages it, no new group', () => {
    expect(managerWords({ by: 'there', newGroup: false }, 'studio-mbp')).toEqual({
      eyebrow: 'JOIN REQUEST',
      line: 'studio-mbp manages the group: devices are added and removed there.',
      done: 'studio-mbp manages the group: add more devices there.',
    })
  })

  it('a pairing by hand says nothing about who manages', () => {
    expect(managerWords(null, 'mini-office')).toEqual({ eyebrow: 'JOIN REQUEST', line: null, done: null })
  })
})
