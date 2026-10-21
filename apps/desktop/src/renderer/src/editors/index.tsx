import type { ItemType } from '@ternix/core/items';
import { useMemo, useState } from 'react';
import { call } from '../api.js';
import { BIND_ADDRESS_MESSAGE, looksLikeLocalBindAddress } from '../../../shared/forwards.js';
import { groupDefaultPort } from '../../../shared/groups.js';
import { type PayloadOf, tileColor, TILE_COLORS } from '../items.js';
import { type EditorTarget, useStore } from '../store.js';
import { Button, Checkbox, FormCard, Notice, Select, TextArea, TextField } from '../ui.js';
import { Tile } from '../cards.js';
import { Server } from 'lucide-react';
import {
  EditorFrame,
  ItemSelect,
  optional,
  optionalId,
  parsePort,
  parseTags,
  SecretInput,
  secretDraft,
  useSecret,
} from './common.js';

const COLORS = ['', ...TILE_COLORS];

/** The payload being edited, when it is of the expected type. */
function existing<T extends ItemType>(target: EditorTarget, type: T): PayloadOf<T> | undefined {
  const payload = target.item?.payload;
  return payload?.type === type ? (payload as PayloadOf<T>) : undefined;
}

/** Opens the editor the store asks for. */
export function ItemEditor() {
  const target = useStore((s) => s.editor);
  if (!target) return null;
  // Remount for each target so form state never leaks between items.
  const key = `${target.type}:${target.item?.id ?? 'new'}`;
  switch (target.type) {
    case 'host':
      return <HostEditor key={key} target={target} />;
    case 'group':
      return <GroupEditor key={key} target={target} />;
    case 'identity':
      return <IdentityEditor key={key} target={target} />;
    case 'ssh_key':
      return <KeyEditor key={key} target={target} />;
    case 'snippet':
      return <SnippetEditor key={key} target={target} />;
    case 'port_forward':
      return <ForwardEditor key={key} target={target} />;
    default:
      return null;
  }
}

function HostEditor({ target }: { target: EditorTarget }) {
  const h = existing(target, 'host');
  const [label, setLabel] = useState(h?.label ?? target.preset?.['label'] ?? '');
  const [address, setAddress] = useState(h?.address ?? '');
  const items = useStore((s) => s.items);
  const [groupId, setGroupId] = useState(h?.group_id ?? target.preset?.['group_id'] ?? '');
  // A new host starts with the port its group (or the nearest group above) defaults to.
  const [port, setPort] = useState(String(h?.port ?? groupDefaultPort(items, groupId) ?? 22));
  // Until the user types a port, choosing another group re-fills it from that group.
  const [portTouched, setPortTouched] = useState(false);
  const [portFromGroup, setPortFromGroup] = useState(h === undefined && port !== '22');
  const [username, setUsername] = useState(h?.username ?? '');
  const password = useSecret(target, 'password');
  const [identityId, setIdentityId] = useState(h?.identity_id ?? '');
  const [keyId, setKeyId] = useState(h?.key_id ?? '');
  const [jumpId, setJumpId] = useState(h?.jump_host_id ?? '');
  const [snippetId, setSnippetId] = useState(h?.startup_snippet_id ?? '');
  const [keepalive, setKeepalive] = useState(
    h?.keepalive_interval !== undefined ? String(h.keepalive_interval) : '',
  );
  const [agent, setAgent] = useState(h?.agent_forwarding ?? false);
  const [color, setColor] = useState(h?.color ?? '');
  const [tags, setTags] = useState((h?.tags ?? []).join(', '));
  const [notes, setNotes] = useState(h?.notes ?? '');
  const exclude = useMemo(() => new Set(target.item ? [target.item.id] : []), [target.item]);

  return (
    <EditorFrame
      target={target}
      title={h ? 'Edit host' : 'New host'}
      validate={() =>
        label.trim() === ''
          ? 'Enter a label'
          : address.trim() === ''
            ? 'Enter an address'
            : parsePort(port) === null
              ? 'The port must be 1 to 65535'
              : keepalive !== '' && !/^\d+$/.test(keepalive)
                ? 'Keepalive must be a number of seconds'
                : null
      }
      build={() => ({
        type: 'host',
        label: label.trim(),
        address: address.trim(),
        port: parsePort(port) ?? 22,
        ...(optional(username) ? { username: username.trim() } : {}),
        ...secretDraft('password', password.draftValue()),
        ...(optionalId(identityId) ? { identity_id: identityId } : {}),
        ...(optionalId(keyId) ? { key_id: keyId } : {}),
        ...(optionalId(groupId) ? { group_id: groupId } : {}),
        ...(optionalId(jumpId) ? { jump_host_id: jumpId } : {}),
        tags: parseTags(tags),
        ...(optionalId(snippetId) ? { startup_snippet_id: snippetId } : {}),
        ...(keepalive !== '' ? { keepalive_interval: Number(keepalive) } : {}),
        agent_forwarding: agent,
        ...(color ? { color } : {}),
        ...(optional(notes) ? { notes } : {}),
      })}
    >
      {({ vaultId, readOnly }) => (
        <>
          <FormCard title="Address">
            <div className="address-row">
              <Tile color={tileColor(label.trim() || 'host', color || undefined)} icon={Server} />
              <TextField
                label="Address"
                value={address}
                onChange={setAddress}
                disabled={readOnly}
                placeholder="hostname or IP"
                spellCheck={false}
              />
            </div>
            <TextField
              label="Port"
              value={port}
              onChange={(value) => {
                setPort(value);
                setPortTouched(true);
              }}
              disabled={readOnly}
              inputMode="numeric"
            />
          </FormCard>
          <FormCard title="General">
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              disabled={readOnly}
              autoFocus
            />
            <ItemSelect
              label="Group"
              type="group"
              value={groupId}
              onChange={(id) => {
                setGroupId(id);
                if (!portTouched && (port === '22' || portFromGroup)) {
                  const inherited = groupDefaultPort(items, id);
                  setPort(String(inherited ?? 22));
                  setPortFromGroup(inherited !== undefined);
                }
              }}
              targetVaultId={vaultId}
              disabled={readOnly}
            />
            <TextField
              label="Tags"
              value={tags}
              onChange={setTags}
              disabled={readOnly}
              hint="Comma separated"
            />
            <div>
              <div className="field-static-label">Color</div>
              <div className="swatches">
                {COLORS.map((c) => (
                  <button
                    key={c || 'none'}
                    type="button"
                    className={`swatch ${color === c ? 'selected' : ''}`}
                    style={{ background: c || 'transparent' }}
                    aria-label={c ? `Color ${c}` : 'No color'}
                    disabled={readOnly}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
          </FormCard>
          <FormCard title="Credentials">
            <TextField
              label="Username"
              value={username}
              onChange={setUsername}
              disabled={readOnly}
              hint="Leave empty to use the identity's or the group's."
              spellCheck={false}
            />
            <SecretInput label="Password" secret={password} readOnly={readOnly} />
            <ItemSelect
              label="Identity"
              type="identity"
              value={identityId}
              onChange={setIdentityId}
              targetVaultId={vaultId}
              disabled={readOnly}
            />
            <ItemSelect
              label="SSH key"
              type="ssh_key"
              value={keyId}
              onChange={setKeyId}
              targetVaultId={vaultId}
              disabled={readOnly}
            />
          </FormCard>
          <FormCard title="Advanced">
            <ItemSelect
              label="Jump host"
              type="host"
              value={jumpId}
              onChange={setJumpId}
              targetVaultId={vaultId}
              exclude={exclude}
              disabled={readOnly}
            />
            <ItemSelect
              label="Startup snippet"
              type="snippet"
              value={snippetId}
              onChange={setSnippetId}
              targetVaultId={vaultId}
              disabled={readOnly}
            />
            <TextField
              label="Keepalive (seconds)"
              value={keepalive}
              onChange={setKeepalive}
              disabled={readOnly}
              placeholder="off"
              inputMode="numeric"
            />
            <Checkbox
              label="Forward my SSH agent to this host"
              checked={agent}
              onChange={setAgent}
              disabled={readOnly}
            />
          </FormCard>
          <FormCard title="Notes">
            <TextArea
              label="Notes"
              value={notes}
              onChange={setNotes}
              disabled={readOnly}
              rows={3}
            />
          </FormCard>
        </>
      )}
    </EditorFrame>
  );
}

function GroupEditor({ target }: { target: EditorTarget }) {
  const g = existing(target, 'group');
  const items = useStore((s) => s.items);
  const [label, setLabel] = useState(g?.label ?? '');
  const [parentId, setParentId] = useState(g?.parent_id ?? target.preset?.['parent_id'] ?? '');
  const [username, setUsername] = useState(g?.username ?? '');
  const [port, setPort] = useState(g?.port !== undefined ? String(g.port) : '');
  const [identityId, setIdentityId] = useState(g?.identity_id ?? '');
  // A group cannot move under itself or one of its own subgroups.
  const exclude = useMemo(() => {
    const out = new Set<string>();
    if (!target.item) return out;
    out.add(target.item.id);
    for (let grew = true; grew;) {
      grew = false;
      for (const i of items) {
        if (
          i.payload.type === 'group' &&
          i.payload.parent_id &&
          out.has(i.payload.parent_id) &&
          !out.has(i.id)
        ) {
          out.add(i.id);
          grew = true;
        }
      }
    }
    return out;
  }, [items, target.item]);

  return (
    <EditorFrame
      target={target}
      title={g ? 'Edit group' : 'New group'}
      validate={() =>
        label.trim() === ''
          ? 'Enter a label'
          : port !== '' && parsePort(port) === null
            ? 'The port must be 1 to 65535'
            : null
      }
      build={() => ({
        type: 'group',
        label: label.trim(),
        ...(optionalId(parentId) ? { parent_id: parentId } : {}),
        ...(optional(username) ? { username: username.trim() } : {}),
        ...(port !== '' ? { port: parsePort(port) ?? 22 } : {}),
        ...(optionalId(identityId) ? { identity_id: identityId } : {}),
      })}
    >
      {({ vaultId, readOnly }) => (
        <>
          <FormCard title="General">
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              disabled={readOnly}
              autoFocus
            />
            <ItemSelect
              label="Inside group"
              type="group"
              value={parentId}
              onChange={setParentId}
              targetVaultId={vaultId}
              exclude={exclude}
              disabled={readOnly}
              noneLabel="Top level"
            />
          </FormCard>
          <FormCard title="Defaults">
            <Notice>
              Hosts in this group use the username and identity for anything they do not set
              themselves. The port is only filled in when you create a host here.
            </Notice>
            <TextField
              label="Default username"
              value={username}
              onChange={setUsername}
              disabled={readOnly}
            />
            <TextField
              label="Default port"
              value={port}
              onChange={setPort}
              disabled={readOnly}
              inputMode="numeric"
              hint="Default port for new hosts in this group."
            />
            <ItemSelect
              label="Default identity"
              type="identity"
              value={identityId}
              onChange={setIdentityId}
              targetVaultId={vaultId}
              disabled={readOnly}
            />
          </FormCard>
        </>
      )}
    </EditorFrame>
  );
}

function IdentityEditor({ target }: { target: EditorTarget }) {
  const i = existing(target, 'identity');
  const [label, setLabel] = useState(i?.label ?? '');
  const [username, setUsername] = useState(i?.username ?? '');
  const password = useSecret(target, 'password');
  const [keyId, setKeyId] = useState(i?.key_id ?? '');
  return (
    <EditorFrame
      target={target}
      title={i ? 'Edit identity' : 'New identity'}
      validate={() =>
        label.trim() === '' ? 'Enter a label' : username.trim() === '' ? 'Enter a username' : null
      }
      build={() => ({
        type: 'identity',
        label: label.trim(),
        username: username.trim(),
        ...secretDraft('password', password.draftValue()),
        ...(optionalId(keyId) ? { key_id: keyId } : {}),
      })}
    >
      {({ vaultId, readOnly }) => (
        <>
          <FormCard title="General">
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              disabled={readOnly}
              autoFocus
            />
          </FormCard>
          <FormCard title="Credentials">
            <TextField
              label="Username"
              value={username}
              onChange={setUsername}
              disabled={readOnly}
              spellCheck={false}
            />
            <SecretInput label="Password" secret={password} readOnly={readOnly} />
            <ItemSelect
              label="SSH key"
              type="ssh_key"
              value={keyId}
              onChange={setKeyId}
              targetVaultId={vaultId}
              disabled={readOnly}
            />
          </FormCard>
        </>
      )}
    </EditorFrame>
  );
}

function KeyEditor({ target }: { target: EditorTarget }) {
  const k = existing(target, 'ssh_key');
  const [label, setLabel] = useState(k?.label ?? '');
  const privateKey = useSecret(target, 'private_key');
  const passphrase = useSecret(target, 'passphrase');
  const [publicKey, setPublicKey] = useState(k?.public_key ?? '');
  const [importError, setImportError] = useState<string | null>(null);
  const looksLikeKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey.value);
  // A stored key the user did not touch is kept; a new or replaced one must be pasted.
  const hasKey = privateKey.touched || !privateKey.stored ? privateKey.value.trim() !== '' : true;

  async function importFile() {
    setImportError(null);
    try {
      const file = await call('dialog.importKey');
      if (!file) return;
      privateKey.set(file.content.trim() + '\n');
      if (label.trim() === '') setLabel(file.fileName.replace(/\.(pem|key)$/i, ''));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <EditorFrame
      target={target}
      title={k ? 'Edit SSH key' : 'New SSH key'}
      validate={() =>
        label.trim() === '' ? 'Enter a label' : !hasKey ? 'Paste or import a private key' : null
      }
      build={() => ({
        type: 'ssh_key',
        label: label.trim(),
        ...secretDraft(
          'private_key',
          privateKey.draftValue((v) => v.trim() + '\n'),
        ),
        ...secretDraft('passphrase', passphrase.draftValue()),
        ...(optional(publicKey) ? { public_key: publicKey.trim() } : {}),
      })}
    >
      {({ readOnly }) => (
        <>
          <FormCard title="General">
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              disabled={readOnly}
              autoFocus
            />
          </FormCard>
          <FormCard title="Private key">
            <SecretInput
              label="Private key"
              secret={privateKey}
              readOnly={readOnly}
              multiline
              optional={false}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              hint={
                privateKey.value !== '' && !looksLikeKey ? (
                  <span className="warn">This does not look like a PEM/OpenSSH private key.</span>
                ) : undefined
              }
            />
            {!readOnly ? (
              <div className="row">
                <Button size="md" onClick={() => void importFile()}>
                  Import from file…
                </Button>
                {importError ? <span className="error-text">{importError}</span> : null}
              </div>
            ) : null}
            <SecretInput
              label="Passphrase"
              secret={passphrase}
              readOnly={readOnly}
              hint="Only if the key is encrypted."
            />
          </FormCard>
          <FormCard title="Public key">
            <TextField
              label="Public key (optional)"
              value={publicKey}
              onChange={setPublicKey}
              disabled={readOnly}
              spellCheck={false}
            />
          </FormCard>
        </>
      )}
    </EditorFrame>
  );
}

function SnippetEditor({ target }: { target: EditorTarget }) {
  const s = existing(target, 'snippet');
  const [label, setLabel] = useState(s?.label ?? '');
  const [script, setScript] = useState(s?.script ?? '');
  const [tags, setTags] = useState((s?.tags ?? []).join(', '));
  return (
    <EditorFrame
      target={target}
      title={s ? 'Edit snippet' : 'New snippet'}
      validate={() => (label.trim() === '' ? 'Enter a label' : null)}
      build={() => ({ type: 'snippet', label: label.trim(), script, tags: parseTags(tags) })}
    >
      {({ readOnly }) => (
        <>
          <FormCard title="General">
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              disabled={readOnly}
              autoFocus
            />
            <TextField
              label="Tags"
              value={tags}
              onChange={setTags}
              disabled={readOnly}
              hint="Comma separated"
            />
          </FormCard>
          <FormCard title="Script">
            <TextArea
              label="Script"
              value={script}
              onChange={setScript}
              disabled={readOnly}
              mono
              rows={8}
            />
          </FormCard>
        </>
      )}
    </EditorFrame>
  );
}

function ForwardEditor({ target }: { target: EditorTarget }) {
  const f = existing(target, 'port_forward');
  const [label, setLabel] = useState(f?.label ?? '');
  const [hostId, setHostId] = useState(f?.host_id ?? target.preset?.['host_id'] ?? '');
  const [kind, setKind] = useState<PayloadOf<'port_forward'>['kind']>(f?.kind ?? 'local');
  const [bindAddress, setBindAddress] = useState(f?.bind_address ?? '127.0.0.1');
  const [bindPort, setBindPort] = useState(f ? String(f.bind_port) : '');
  const [destHost, setDestHost] = useState(f?.dest_host ?? '');
  const [destPort, setDestPort] = useState(f?.dest_port !== undefined ? String(f.dest_port) : '');
  const needsDest = kind !== 'dynamic';
  const bindOk = /^\d+$/.test(bindPort) && Number(bindPort) <= 65535;
  return (
    <EditorFrame
      target={target}
      title={f ? 'Edit port forward' : 'New port forward'}
      validate={() =>
        label.trim() === ''
          ? 'Enter a label'
          : hostId === ''
            ? 'Choose a host'
            : !bindOk
              ? 'The listen port must be 0 to 65535'
              : bindAddress.trim() === ''
                ? 'Enter a listen address'
                : kind !== 'remote' && !looksLikeLocalBindAddress(bindAddress)
                  ? BIND_ADDRESS_MESSAGE
                  : needsDest && (destHost.trim() === '' || parsePort(destPort) === null)
                    ? 'Enter the destination host and port'
                    : null
      }
      build={() => ({
        type: 'port_forward',
        label: label.trim(),
        host_id: hostId,
        kind,
        bind_address: bindAddress.trim(),
        bind_port: Number(bindPort),
        ...(needsDest ? { dest_host: destHost.trim(), dest_port: parsePort(destPort) ?? 1 } : {}),
      })}
    >
      {({ vaultId, readOnly }) => (
        <>
          <FormCard title="General">
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              disabled={readOnly}
              autoFocus
            />
            <ItemSelect
              label="Host"
              type="host"
              value={hostId}
              onChange={setHostId}
              targetVaultId={vaultId}
              disabled={readOnly}
              noneLabel="Choose a host"
            />
            <Select
              label="Type"
              value={kind}
              onChange={setKind}
              disabled={readOnly}
              options={[
                {
                  value: 'local',
                  label: 'Local: a port here reaches a destination through the host',
                },
                {
                  value: 'remote',
                  label: 'Remote: a port on the host reaches a destination from here',
                },
                { value: 'dynamic', label: 'Dynamic: a SOCKS5 proxy on this computer' },
              ]}
            />
          </FormCard>
          <FormCard title="Listen">
            <div className="grid-addr">
              <TextField
                label="Listen address"
                value={bindAddress}
                onChange={setBindAddress}
                disabled={readOnly}
                spellCheck={false}
                hint={kind === 'remote' ? 'On the remote host.' : 'On this computer.'}
              />
              <TextField
                label="Listen port"
                value={bindPort}
                onChange={setBindPort}
                disabled={readOnly}
                inputMode="numeric"
                hint="0 lets the system choose."
              />
            </div>
          </FormCard>
          {needsDest ? (
            <FormCard title="Destination">
              <div className="grid-addr">
                <TextField
                  label="Destination host"
                  value={destHost}
                  onChange={setDestHost}
                  disabled={readOnly}
                  spellCheck={false}
                />
                <TextField
                  label="Destination port"
                  value={destPort}
                  onChange={setDestPort}
                  disabled={readOnly}
                  inputMode="numeric"
                />
              </div>
            </FormCard>
          ) : null}
        </>
      )}
    </EditorFrame>
  );
}
