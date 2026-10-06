import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Modal, TextArea, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { splitAliases } from './utils';
import type { Person } from '../../api/types';

export function PersonEditDialog({
  fid,
  person,
  open,
  onClose,
}: {
  fid: string;
  person: Person;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [form, setForm] = useState({
    name: person.name,
    aliases: person.aliases.join('、'),
    relation: person.relation ?? '',
    relationNote: person.relationNote ?? '',
    birthYear: person.birthYear ? String(person.birthYear) : '',
    deathYear: person.deathYear ? String(person.deathYear) : '',
    bio: person.bio ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/families/${fid}/people/${person.id}`, {
        name: form.name.trim(),
        aliases: splitAliases(form.aliases),
        relation: form.relation.trim() || null,
        relationNote: form.relationNote.trim() || null,
        birthYear: form.birthYear ? Number(form.birthYear) : null,
        deathYear: form.deathYear ? Number(form.deathYear) : null,
        bio: form.bio.trim() || null,
      }),
    onSuccess: async () => {
      push('人物档案已更新', 'success');
      await queryClient.invalidateQueries({ queryKey: ['person', fid, person.id] });
      await queryClient.invalidateQueries({ queryKey: ['people', fid] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '保存失败'),
  });

  return (
    <Modal
      open={open}
      title="编辑人物"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!form.name.trim()}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <Field label="称呼" required>
        <TextInput value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} autoFocus />
      </Field>
      <Field label="别名" hint="多个别名用顿号或逗号隔开">
        <TextInput value={form.aliases} onChange={(e) => setForm((p) => ({ ...p, aliases: e.target.value }))} />
      </Field>
      <Field label="关系" hint="一句话关系">
        <TextInput value={form.relation} onChange={(e) => setForm((p) => ({ ...p, relation: e.target.value }))} />
      </Field>
      <Field label="关系描述" hint="多写几句渊源">
        <TextArea
          value={form.relationNote}
          onChange={(e) => setForm((p) => ({ ...p, relationNote: e.target.value }))}
          maxLength={500}
        />
      </Field>
      <div className="form-grid">
        <Field label="出生年份">
          <TextInput
            type="number"
            value={form.birthYear}
            onChange={(e) => setForm((p) => ({ ...p, birthYear: e.target.value }))}
          />
        </Field>
        <Field label="去世年份">
          <TextInput
            type="number"
            value={form.deathYear}
            onChange={(e) => setForm((p) => ({ ...p, deathYear: e.target.value }))}
          />
        </Field>
      </div>
      <Field label="小传">
        <TextArea
          value={form.bio}
          onChange={(e) => setForm((p) => ({ ...p, bio: e.target.value }))}
          maxLength={2000}
        />
      </Field>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
