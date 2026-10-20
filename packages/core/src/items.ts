import { z } from 'zod';
import { B64_RE } from './b64.js';
import { timestampSchema, uuidSchema } from './protocol/common.js';

/**
 * Item payloads: the plaintext inside an item ciphertext (docs/protocol.md section 3).
 * References (`*_id`) are item IDs; a missing reference is treated as unset by clients.
 */

const SCHEMA_VERSION = 1;

const idRef = uuidSchema;
const label = z.string().min(1).max(200);
const port = z.number().int().min(1).max(65535);
const timestamp = timestampSchema;
const tags = z.array(z.string().min(1).max(100)).default([]);

const common = {
  schema: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  updated_at: timestamp,
};

export const groupPayloadSchema = z.object({
  type: z.literal('group'),
  ...common,
  label,
  parent_id: idRef.optional(),
  username: z.string().optional(),
  port: port.optional(),
  identity_id: idRef.optional(),
});

export const hostPayloadSchema = z.object({
  type: z.literal('host'),
  ...common,
  label,
  address: z.string().min(1).max(255),
  port: port.default(22),
  username: z.string().optional(),
  password: z.string().optional(),
  identity_id: idRef.optional(),
  key_id: idRef.optional(),
  group_id: idRef.optional(),
  jump_host_id: idRef.optional(),
  tags,
  startup_snippet_id: idRef.optional(),
  keepalive_interval: z.number().int().min(0).optional(),
  agent_forwarding: z.boolean().default(false),
  color: z.string().max(32).optional(),
  notes: z.string().optional(),
});

export const identityPayloadSchema = z.object({
  type: z.literal('identity'),
  ...common,
  label,
  username: z.string().min(1),
  password: z.string().optional(),
  key_id: idRef.optional(),
});

export const sshKeyPayloadSchema = z.object({
  type: z.literal('ssh_key'),
  ...common,
  label,
  /** OpenSSH PEM. */
  private_key: z.string().min(1),
  passphrase: z.string().optional(),
  public_key: z.string().optional(),
});

export const snippetPayloadSchema = z.object({
  type: z.literal('snippet'),
  ...common,
  label,
  script: z.string(),
  tags,
});

export const portForwardKindSchema = z.enum(['local', 'remote', 'dynamic']);

export const portForwardPayloadSchema = z.object({
  type: z.literal('port_forward'),
  ...common,
  label,
  host_id: idRef,
  kind: portForwardKindSchema,
  bind_address: z.string().min(1),
  bind_port: z.number().int().min(0).max(65535),
  dest_host: z.string().min(1).optional(),
  dest_port: port.optional(),
});

export const knownHostPayloadSchema = z.object({
  type: z.literal('known_host'),
  ...common,
  host: z.string().min(1),
  port,
  key_type: z.string().min(1),
  /** Host key in SSH wire format, standard base64. */
  public_key: z.string().min(1).regex(B64_RE),
});

export const itemPayloadSchema = z.discriminatedUnion('type', [
  groupPayloadSchema,
  hostPayloadSchema,
  identityPayloadSchema,
  sshKeyPayloadSchema,
  snippetPayloadSchema,
  portForwardPayloadSchema,
  knownHostPayloadSchema,
]);

export const ITEM_TYPES = [
  'group',
  'host',
  'identity',
  'ssh_key',
  'snippet',
  'port_forward',
  'known_host',
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

/** Parsed payload: defaults applied. */
export type ItemPayload = z.infer<typeof itemPayloadSchema>;
/** Payload as a caller may write it: fields with defaults are optional. */
export type ItemPayloadInput = z.input<typeof itemPayloadSchema>;

export type GroupPayload = z.infer<typeof groupPayloadSchema>;
export type HostPayload = z.infer<typeof hostPayloadSchema>;
export type IdentityPayload = z.infer<typeof identityPayloadSchema>;
export type SshKeyPayload = z.infer<typeof sshKeyPayloadSchema>;
export type SnippetPayload = z.infer<typeof snippetPayloadSchema>;
export type PortForwardPayload = z.infer<typeof portForwardPayloadSchema>;
export type KnownHostPayload = z.infer<typeof knownHostPayloadSchema>;
