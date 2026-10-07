import { expect, test } from 'bun:test'
import type { WAMessage } from 'baileys'
import { normalizeWAMessage } from '../../../src/providers/whatsapp/normalize.ts'

const SELF = '5491100000000@s.whatsapp.net'

function waMessage(overrides: Record<string, unknown> = {}): WAMessage {
  return {
    key: {
      remoteJid: '120363000000000000@g.us',
      id: 'ABC123',
      fromMe: false,
      participant: '5491111111111@s.whatsapp.net',
    },
    messageTimestamp: {
      low: 1788091200,
      high: 0,
      unsigned: true,
      toString: () => '1788091200',
    },
    pushName: 'Ana',
    message: { conversation: 'hola gente' },
    ...overrides,
  } as unknown as WAMessage
}

test('normaliza un mensaje de texto de grupo', () => {
  const result = normalizeWAMessage(waMessage(), SELF)

  expect(result).not.toBeNull()
  expect(result?.externalId).toBe('120363000000000000@g.us:ABC123')
  expect(result?.text).toBe('hola gente')
  expect(result?.conversation.kind).toBe('group')
  expect(result?.conversation.externalId).toBe('120363000000000000@g.us')
  expect(result?.sender?.externalId).toBe('5491111111111@s.whatsapp.net')
  expect(result?.sender?.displayName).toBe('Ana')
  expect(result?.fromSelf).toBe(false)
  expect(result?.sentAt.toISOString()).toBe('2026-08-30T12:00:00.000Z')
})

test('detecta una conversación uno a uno', () => {
  const result = normalizeWAMessage(
    waMessage({ key: { remoteJid: '5491111111111@s.whatsapp.net', id: 'X1', fromMe: false } }),
    SELF,
  )

  expect(result?.conversation.kind).toBe('dm')
  expect(result?.conversation.name).toBeNull()
  expect(result?.sender?.externalId).toBe('5491111111111@s.whatsapp.net')
  expect(result?.sender?.displayName).toBe('Ana')
})

test('no usa el nombre propio como nombre de una conversación saliente', () => {
  const result = normalizeWAMessage(
    waMessage({
      key: { remoteJid: '5491111111111@s.whatsapp.net', id: 'X1-OUT', fromMe: true },
      pushName: 'Mi Nombre',
    }),
    SELF,
  )

  expect(result?.conversation.name).toBeNull()
  expect(result?.sender?.externalId).toBe(SELF)
})

test('marca fromSelf cuando el mensaje es propio', () => {
  const result = normalizeWAMessage(
    waMessage({ key: { remoteJid: '120363000000000000@g.us', id: 'X2', fromMe: true } }),
    SELF,
  )

  expect(result?.fromSelf).toBe(true)
  expect(result?.sender?.externalId).toBe(SELF)
})

test('extrae el texto de un mensaje extendido', () => {
  const result = normalizeWAMessage(
    waMessage({ message: { extendedTextMessage: { text: 'con formato' } } }),
    SELF,
  )

  expect(result?.text).toBe('con formato')
})

test('desenvuelve mensajes efímeros', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: { ephemeralMessage: { message: { conversation: 'desaparece' } } },
    }),
    SELF,
  )

  expect(result?.text).toBe('desaparece')
})

test('traduce una nota de voz a un adjunto de audio', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 45, fileLength: 20480 },
      },
    }),
    SELF,
  )

  expect(result?.attachments).toHaveLength(1)
  expect(result?.attachments[0]?.kind).toBe('audio')
  expect(result?.attachments[0]?.durationMs).toBe(45000)
  expect(result?.attachments[0]?.sizeBytes).toBe(20480)
})

test('toma el caption de una imagen como texto', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        imageMessage: { mimetype: 'image/jpeg', caption: 'mirá esto', fileLength: 1000 },
      },
    }),
    SELF,
  )

  expect(result?.text).toBe('mirá esto')
  expect(result?.attachments[0]?.kind).toBe('image')
})

test('descarta los estados, que llegan como un chat más', () => {
  const result = normalizeWAMessage(
    waMessage({
      key: { remoteJid: 'status@broadcast', id: 'ESTADO-1', fromMe: false },
    }),
    SELF,
  )

  expect(result).toBeNull()
})

test('descarta las listas de difusión', () => {
  const result = normalizeWAMessage(
    waMessage({
      key: { remoteJid: '1234567890@broadcast', id: 'DIFUSION-1', fromMe: true },
    }),
    SELF,
  )

  expect(result).toBeNull()
})

test('devuelve null si falta la clave o el id', () => {
  expect(
    normalizeWAMessage(waMessage({ key: { remoteJid: null, id: 'HAS-ID' } }), SELF),
  ).toBeNull()
  expect(
    normalizeWAMessage(
      waMessage({ key: { remoteJid: '5491111111111@s.whatsapp.net', id: null } }),
      SELF,
    ),
  ).toBeNull()
})

test('devuelve null para mensajes sin contenido interpretable', () => {
  expect(normalizeWAMessage(waMessage({ message: {} }), SELF)).toBeNull()
})

test('detecta una respuesta de texto', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        extendedTextMessage: {
          text: 'respuesta',
          contextInfo: { stanzaId: 'QUOTED-TEXT' },
        },
      },
    }),
    SELF,
  )

  expect(result?.replyToExternalId).toBe('120363000000000000@g.us:QUOTED-TEXT')
})

test('detecta una respuesta enviada con una imagen', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          caption: 'respuesta visual',
          contextInfo: { stanzaId: 'QUOTED-IMAGE' },
        },
      },
    }),
    SELF,
  )

  expect(result?.replyToExternalId).toBe('120363000000000000@g.us:QUOTED-IMAGE')
})

test('desenvuelve mensajes de vista única', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: { viewOnceMessage: { message: { imageMessage: { caption: 'una vez' } } } },
    }),
    SELF,
  )

  expect(result?.text).toBe('una vez')
  expect(result?.attachments[0]?.kind).toBe('image')
})

test('desenvuelve mensajes de vista única V2', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: { viewOnceMessageV2: { message: { conversation: 'una vez V2' } } },
    }),
    SELF,
  )

  expect(result?.text).toBe('una vez V2')
})

test('desenvuelve mensajes de vista única V2 Extension', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        viewOnceMessageV2Extension: {
          message: { imageMessage: { caption: 'extensión de vista única' } },
        },
      },
    }),
    SELF,
  )

  expect(result?.text).toBe('extensión de vista única')
  expect(result?.attachments[0]?.kind).toBe('image')
})

test('desenvuelve dos capas anidadas', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        ephemeralMessage: {
          message: {
            viewOnceMessageV2: {
              message: { imageMessage: { caption: 'doblemente envuelto' } },
            },
          },
        },
      },
    }),
    SELF,
  )

  expect(result?.text).toBe('doblemente envuelto')
  expect(result?.attachments[0]?.kind).toBe('image')
})

test('devuelve null si una clave válida no tiene mensaje', () => {
  expect(normalizeWAMessage(waMessage({ message: undefined }), SELF)).toBeNull()
})

test('devuelve null si falta el timestamp', () => {
  expect(normalizeWAMessage(waMessage({ messageTimestamp: undefined }), SELF)).toBeNull()
})

test('devuelve null si el timestamp no es numérico', () => {
  expect(normalizeWAMessage(waMessage({ messageTimestamp: 'no-es-un-timestamp' }), SELF)).toBeNull()
})

test('normaliza una nota de video con su respuesta citada', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        ptvMessage: {
          mimetype: 'video/mp4',
          seconds: 12,
          fileLength: 4096,
          caption: 'nota de video',
          contextInfo: { stanzaId: 'QUOTED-PTV' },
        },
      },
    }),
    SELF,
  )

  expect(result?.text).toBe('nota de video')
  expect(result?.attachments).toEqual([
    {
      externalId: '120363000000000000@g.us:ABC123:0',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      durationMs: 12000,
    },
  ])
  expect(result?.replyToExternalId).toBe('120363000000000000@g.us:QUOTED-PTV')
})
