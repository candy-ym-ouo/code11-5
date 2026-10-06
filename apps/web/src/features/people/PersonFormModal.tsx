import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Modal, TextArea, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import type { Person } from '../../api/types';

interface PersonFormState {
  name: string;
  aliasesText: string;
  relation: string;
  relationNote: string;
  birthYear: string;
  deathYear: string;
  bio: string;
}

function fromPerson(p: Person): PersonFormState {
  return {
    name: p.name,
    aliasesText: p.aliases.join('、'),
    relation: p.relation ?? '',
    relationNote: p.relationNote ?? '',
    birthYear: p.birthYear ? String(p.birthYear) : '',
    deathYear: p.deathYear ? String(p.deathYear) : '',
    bio: p.bio ?? '',
  };
}

/** 人物档案表单：新建 / 编辑共用。别名用顿号或逗号分隔。 */
export function PersonFormModal({
  fid,
  open,
  person,
  onClose,
  onSaved,
}: {
  fid: string;
  open: boolean;
  person?: Person | null;
  onClose: () => void;
  onSaved?: (p: Person) => void;
}) {
  const mode = person ? 'edit' : 'create';
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [form, setForm] = useState<PersonFormState>(
    person ? fromPerson(person) : { name: '', aliasesText: '', relation: '', relationNote: '', birthYear: '', deathYear: '', bio: '' },
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        aliases: form.aliasesText.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean),
        relation: form.relation.trim() || null,
        relationNote: form.relationNote.trim() || null,
        birthYear: form.birthYear ? Number(form.birthYear) : null,
        deathYear: form.deathYear ? Number(form.deathYear) : null,
        bio: form.bio.trim() || null,
      };
      if (mode === 'edit') {
        return api.patch<{ person: Person }>(`/families/${fid}/people/${person!.id}`, payload);
      }
      return api.post<{ person: Person }>(`/families/${fid}/people`, payload);
    },
    onSuccess: async (data) => {
      push(mode === 'edit' ? '人物档案已更新' : '人物已建立', 'success');
      await queryClient.invalidateQueries({ queryKey: ['people', fid] });
      await queryClient.invalidateQueries({ queryKey: ['person', fid] });
      onSaved?.(data.person);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '保存失败'),
  });

  return (
    <Modal
      open={open}
      title={mode === 'edit' ? `编辑人物：${person!.name}` : '新建人物'}
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
      <Field label="称呼" required hint="例如「外公」「王阿姨」">
        <TextInput
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          autoFocus
          maxLength={60}
        />
      </Field>
      <Field label="别名 / 曾用名 / 乳名" hint="多个用顿号分隔，例如「老张、张师傅」；按别名也能搜到这个人">
        <TextInput
          value={form.aliasesText}
          onChange={(e) => setForm((p) => ({ ...p, aliasesText: e.target.value }))}
          maxLength={200}
          placeholder="外公、老张"
        />
      </Field>
      <div className="form-grid">
        <Field label="关系" hint="例如「外公」「老同事」">
          <TextInput value={form.relation} onChange={(e) => setForm((p) => ({ ...p, relation: e.target.value }))} maxLength={40} />
        </Field>
        <Field label="关系说明" hint="一句话讲清这层关系，例如「母亲的大哥，住绍兴」">
          <TextInput
            value={form.relationNote}
            onChange={(e) => setForm((p) => ({ ...p, relationNote: e.target.value }))}
            maxLength={500}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="出生年份">
          <TextInput type="number" min={1800} max={2200} value={form.birthYear} onChange={(e) => setForm((p) => ({ ...p, birthYear: e.target.value }))} />
        </Field>
        <Field label="去世年份">
          <TextInput type="number" min={1800} max={2200} value={form.deathYear} onChange={(e) => setForm((p) => ({ ...p, deathYear: e.target.value }))} />
        </Field>
      </div>
      <Field label="小传" hint="选填，几句话就行">
        <TextArea value={form.bio} onChange={(e) => setForm((p) => ({ ...p, bio: e.target.value }))} maxLength={2000} />
      </Field>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
