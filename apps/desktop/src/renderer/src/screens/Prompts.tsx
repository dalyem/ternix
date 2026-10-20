import { useState } from 'react';
import type { KeyboardPromptDto } from '../../../shared/app.js';
import { call } from '../api.js';
import { answerPrompt, useStore } from '../store.js';
import { Button, ErrorText, Modal, TextField, useAction } from '../ui.js';

/**
 * Keyboard-interactive prompts from the main process, one at a time. Host keys are not asked
 * here: main shows its own native dialog for those.
 */
export function PromptHost() {
  const prompt = useStore((s) => s.prompts[0]);
  if (!prompt) return null;
  return <KeyboardDialog key={prompt.promptId} prompt={prompt} />;
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
