import { useState } from 'react';
import type { HostKeyPromptDto, KeyboardPromptDto } from '../../../shared/app.js';
import { call } from '../api.js';
import { answerPrompt, useStore } from '../store.js';
import { Button, ErrorText, Fingerprint, Modal, Notice, TextField, useAction } from '../ui.js';

/** SSH prompts from the main process, one at a time. */
export function PromptHost() {
  const prompt = useStore((s) => s.prompts[0]);
  if (!prompt) return null;
  return prompt.kind === 'hostkey' ? (
    <HostKeyDialog key={prompt.promptId} prompt={prompt} />
  ) : (
    <KeyboardDialog key={prompt.promptId} prompt={prompt} />
  );
}

function HostKeyDialog({ prompt }: { prompt: HostKeyPromptDto }) {
  const action = useAction();
  const mismatch = prompt.status === 'mismatch';
  const [understood, setUnderstood] = useState(false);
  const answer = (decision: 'trust' | 'replace' | 'reject') =>
    action.run(async () => {
      await call('ssh.answerHostKey', { promptId: prompt.promptId, decision });
      answerPrompt(prompt.promptId);
    });
  const where =
    prompt.hopTotal > 1
      ? `${prompt.hopLabel} (hop ${prompt.hopIndex + 1} of ${prompt.hopTotal})`
      : null;

  return (
    <Modal
      title={mismatch ? 'WARNING: the host key has changed' : 'Trust this host?'}
      danger={mismatch}
      dismissable={false}
      footer={
        mismatch ? (
          <>
            <Button variant="primary" busy={action.busy} onClick={() => void answer('reject')}>
              Disconnect
            </Button>
            <span className="spacer" />
            <Button
              variant="danger"
              disabled={!understood}
              busy={action.busy}
              onClick={() => void answer('replace')}
            >
              Replace stored key and connect
            </Button>
          </>
        ) : (
          <>
            <Button busy={action.busy} onClick={() => void answer('reject')}>
              Cancel
            </Button>
            <Button variant="primary" busy={action.busy} onClick={() => void answer('trust')}>
              Trust and connect
            </Button>
          </>
        )
      }
    >
      {mismatch ? (
        <Notice tone="danger">
          <strong>Someone may be intercepting your connection</strong>, or the server was
          reinstalled. Ternix saw a different {prompt.keyType} key for{' '}
          <strong>
            {prompt.host}:{prompt.port}
          </strong>{' '}
          than the one you trusted before. Do not continue unless you know why it changed.
        </Notice>
      ) : (
        <p>
          This is the first time Ternix connects to{' '}
          <strong>
            {prompt.host}:{prompt.port}
          </strong>
          {where ? ` (${where})` : ''}. Check that the fingerprint matches the one your server
          reports, for example with{' '}
          <code>ssh-keygen -lf /etc/ssh/ssh_host_{keyFile(prompt.keyType)}_key.pub</code>.
        </p>
      )}
      <dl className="facts">
        <dt>{mismatch ? 'New key' : 'Fingerprint'}</dt>
        <dd>
          <Fingerprint value={prompt.fingerprint} /> <span className="muted">{prompt.keyType}</span>
        </dd>
        {prompt.stored ? (
          <>
            <dt>Trusted key</dt>
            <dd>
              <Fingerprint value={prompt.stored.fingerprint} />{' '}
              <span className="muted">{prompt.stored.keyType}</span>
            </dd>
          </>
        ) : null}
      </dl>
      {mismatch ? (
        <label className="check">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>I know why the key changed and want to trust the new one.</span>
        </label>
      ) : null}
      <ErrorText error={action.error} />
    </Modal>
  );
}

function keyFile(keyType: string): string {
  if (keyType.startsWith('ssh-ed25519')) return 'ed25519';
  if (keyType.startsWith('ecdsa')) return 'ecdsa';
  if (keyType.startsWith('ssh-rsa') || keyType.startsWith('rsa')) return 'rsa';
  return '*';
}

function KeyboardDialog({ prompt }: { prompt: KeyboardPromptDto }) {
  const [answers, setAnswers] = useState<string[]>(() => prompt.prompts.map(() => ''));
  const action = useAction();
  const send = (value: string[] | null) =>
    action.run(async () => {
      await call('ssh.answerKeyboard', { promptId: prompt.promptId, answers: value });
      answerPrompt(prompt.promptId);
    });
  return (
    <Modal
      title={prompt.name || `Sign in to ${prompt.hopLabel}`}
      dismissable={false}
      footer={
        <>
          <Button busy={action.busy} onClick={() => void send(null)}>
            Cancel
          </Button>
          <Button variant="primary" busy={action.busy} onClick={() => void send(answers)}>
            Continue
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(answers);
        }}
      >
        <div className="muted">{prompt.hopLabel}</div>
        {prompt.instructions ? <p className="pre-wrap">{prompt.instructions}</p> : null}
        {prompt.prompts.map((p, index) => (
          <TextField
            key={index}
            label={p.prompt.trim() || 'Response'}
            type={p.echo ? 'text' : 'password'}
            value={answers[index] ?? ''}
            onChange={(value) => setAnswers((a) => a.map((x, i) => (i === index ? value : x)))}
            autoComplete="off"
            autoFocus={index === 0}
          />
        ))}
        <button type="submit" hidden />
        <ErrorText error={action.error} />
      </form>
    </Modal>
  );
}
