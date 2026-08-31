import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import type { WAMessage, WASocket } from 'baileys'
import { WhatsAppProvider } from '../../../src/providers/whatsapp/index.ts'
import { encodeRaw } from '../../../src/store/raw.ts'
import { mensaje } from '../../helpers/fixtures.ts'

const mediaDirs: string[] = []

afterAll(async () => {
  for (const dir of mediaDirs) await rm(dir, { recursive: true, force: true })
})

function stubSocket(): WASocket {
  return {
    ev: { on: () => undefined },
    end: () => undefined,
    user: { id: 'self@s.whatsapp.net' },
  } as unknown as WASocket
}

/**
 * Baileys `downloadMediaMessage` needs `mediaKey` as bytes. After jsonb round-trip those
 * become plain objects unless we persist `{ $bin }` and decode before download. This suite
 * only asserts the adapter reconstructs that shape for the injected downloader — it does
 * not call real WhatsApp. If a future Baileys version still rejects reconstructed payloads
 * for other reasons (missing CDN fields, expired URLs), enrich keeps the failure marker.
 */
test('downloadAttachment feeds downloadMedia with decoded Uint8Array mediaKey, not jsonb $bin', async () => {
  const mediaKey = new Uint8Array([10, 20, 30, 40])
  const encodedRaw = encodeRaw({
    key: { remoteJid: '5491111111111@s.whatsapp.net', id: 'ABC123' },
    message: {
      audioMessage: {
        mediaKey,
        mimetype: 'audio/ogg; codecs=opus',
      },
    },
  })

  // Encoded leaf must still look like jsonb storage, not bytes.
  const storedKey = (encodedRaw as { message: { audioMessage: { mediaKey: unknown } } }).message
    .audioMessage.mediaKey
  expect(storedKey).toEqual({
    $bin: 'b64',
    data: Buffer.from(mediaKey).toString('base64'),
  })

  let received: WAMessage | undefined
  const mediaDir = await mkdtemp(join(tmpdir(), 'bot-whatsapp-download-raw-'))
  mediaDirs.push(mediaDir)

  const provider = new WhatsAppProvider({
    authDir: './unused',
    mediaDir,
    socketFactory: () => stubSocket(),
    downloadMedia: async (raw) => {
      received = raw
      return new Uint8Array([1, 2, 3])
    },
  })

  const attachmentExternalId = 'ABC123:0'
  await provider.downloadAttachment(
    mensaje({
      provider: 'whatsapp',
      conversation: { externalId: '5491111111111@s.whatsapp.net', kind: 'dm', name: null },
      attachments: [
        {
          externalId: attachmentExternalId,
          kind: 'audio',
          mimeType: 'audio/ogg; codecs=opus',
          sizeBytes: 3,
          durationMs: null,
        },
      ],
      raw: encodedRaw,
    }),
    attachmentExternalId,
  )

  expect(received).toBeDefined()
  const passedKey = (
    received as {
      message: { audioMessage: { mediaKey: unknown } }
    }
  ).message.audioMessage.mediaKey
  expect(passedKey).toBeInstanceOf(Uint8Array)
  expect(passedKey).toEqual(mediaKey)
  expect(passedKey).not.toEqual(storedKey)
})

test('downloadAttachment leaves already-decoded mediaKey intact for live payloads', async () => {
  const mediaKey = new Uint8Array([7, 8, 9])
  let received: WAMessage | undefined
  const mediaDir = await mkdtemp(join(tmpdir(), 'bot-whatsapp-download-raw-live-'))
  mediaDirs.push(mediaDir)

  const provider = new WhatsAppProvider({
    authDir: './unused',
    mediaDir,
    socketFactory: () => stubSocket(),
    downloadMedia: async (raw) => {
      received = raw
      return new Uint8Array([9])
    },
  })

  await provider.downloadAttachment(
    mensaje({
      provider: 'whatsapp',
      conversation: { externalId: 'c1', kind: 'dm', name: null },
      attachments: [
        {
          externalId: 'm1:0',
          kind: 'image',
          mimeType: 'image/jpeg',
          sizeBytes: 1,
          durationMs: null,
        },
      ],
      raw: {
        message: { imageMessage: { mediaKey } },
      },
    }),
    'm1:0',
  )

  const passedKey = (
    received as { message: { imageMessage: { mediaKey: unknown } } }
  ).message.imageMessage.mediaKey
  expect(passedKey).toBeInstanceOf(Uint8Array)
  expect(passedKey).toEqual(mediaKey)
})
