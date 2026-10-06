import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, EmptyState, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { ItemCard } from '../items/ItemCard';
import { PERSON_ROLE_LABELS } from '../../lib/constants';
import { formatDateTime } from '../../lib/format';
import { useFamily } from '../families/useFamily';
import { MergeDialog } from './MergeDialog';
import { PersonEditDialog } from './PersonEditDialog';
import type { Person, PersonDetail } from '../../api/types';

export function PersonDetailPage() {
  const { fid, personId } = useParams<{ fid: string; personId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { data: familyData } = useFamily(fid);
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['person', fid, personId],
    queryFn: () => api.get<{ person: PersonDetail }>(`/families/${fid}/people/${personId}`),
    enabled: Boolean(fid && personId),
  });

  const peopleQuery = useQuery({
    queryKey: ['people', fid, ''],
    queryFn: () => api.get<{ people: Person[] }>(`/families/${fid}/people`),
    enabled: Boolean(fid),
  });

  const undo = useMutation({
    mutationFn: (mergeId: string) =>
      api.post<{ person: PersonDetail }>(`/families/${fid}/people/merges/${mergeId}/undo`, {}),
    onSuccess: async () => {
      push('已撤销合并，关联已还原', 'success');
      setUndoError(null);
      await queryClient.invalidateQueries({ queryKey: ['person', fid] });
      await queryClient.invalidateQueries({ queryKey: ['people', fid] });
    },
    onError: (err) => setUndoError(err instanceof ApiError ? err.message : '撤销失败'),
  });

  if (query.isLoading) return <Spinner />;
  const person = query.data?.person;
  if (!person) return <EmptyState title="找不到这个人物" action={<Button onClick={() => navigate(-1)}>返回</Button>} />;

  const canManage = familyData && ['owner', 'admin'].includes(familyData.myRole);
  const merged = Boolean(person.mergedIntoId);
  const latestUndoable = merged
    ? person.mergeHistory.find((m) => m.sourceId === person.id && !m.undone)
    : undefined;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{person.name}</h1>
          {person.aliases.length > 0 ? (
            <p className="page-head__sub" style={{ marginBottom: 4 }}>
              又名：{person.aliases.join('、')}
            </p>
          ) : null}
          <p className="page-head__sub">
            {person.relation ? `${person.relation} · ` : ''}
            {person.birthYear ? `${person.birthYear}${person.deathYear ? `–${person.deathYear}` : ''}` : '年份未记录'}
          </p>
          {merged && person.mergedInto ? (
            <p className="page-head__sub">
              <Tag tone="warn">已合并</Tag>{' '}
              本档案已于合并后进了
              <Link to={`/f/${fid}/people/${person.mergedInto.id}`}>{person.mergedInto.name}</Link>
              ，以下为合并前的历史关联，可追溯还原。
            </p>
          ) : null}
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {canManage && !merged ? (
            <>
              <Button onClick={() => setEditOpen(true)}>编辑</Button>
              <Button variant="danger" onClick={() => setMergeOpen(true)}>
                合并到…
              </Button>
            </>
          ) : null}
          {canManage && latestUndoable ? (
            <Button
              variant="primary"
              loading={undo.isPending}
              onClick={() => {
                setUndoError(null);
                undo.mutate(latestUndoable.id);
              }}
            >
              撤销合并
            </Button>
          ) : null}
          <Button onClick={() => navigate(-1)}>返回</Button>
        </div>
      </div>

      {undoError ? (
        <p className="field__error" role="alert">
          {undoError}
        </p>
      ) : null}

      {person.relationNote ? (
        <section className="card">
          <h2 style={{ marginBottom: 'var(--space-2)' }}>关系渊源</h2>
          <p style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{person.relationNote}</p>
        </section>
      ) : null}

      {person.bio ? (
        <section className="card">
          <h2 style={{ marginBottom: 'var(--space-2)' }}>小传</h2>
          <p style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{person.bio}</p>
        </section>
      ) : null}

      <section>
        <h2 style={{ marginBottom: 'var(--space-3)' }}>
          {merged ? '历史关联' : '相关的物品'}（{person.items.length}）
        </h2>
        {merged ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            这些是合并发生前挂在本人物名下的关联记录；撤销合并后会恢复到物品上。
          </p>
        ) : null}
        {person.items.length === 0 ? (
          <EmptyState
            icon="📦"
            title="还没有关联的物品"
            description="在记录物品时选择这位人物，就会在这里出现。"
          />
        ) : (
          <div className="grid-cards">
            {person.items.map((item) => (
              <div key={`${item.id}-${item.role}`}>
                <ItemCard item={item} fid={fid!} />
                <Tag>{PERSON_ROLE_LABELS[item.role]}</Tag>
              </div>
            ))}
          </div>
        )}
      </section>

      {person.mergeHistory.length > 0 ? (
        <section>
          <h2 style={{ marginBottom: 'var(--space-3)' }}>合并记录</h2>
          <div className="card">
            <ul className="merge-history" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {person.mergeHistory.map((m) => {
                const isSource = m.sourceId === person.id;
                const otherId = isSource ? m.targetId : m.sourceId;
                return (
                  <li key={m.id} className="log-item">
                    <div className="log-item__body">
                      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                        {m.undone ? <Tag tone="muted">已撤销</Tag> : <Tag tone="success">生效中</Tag>}
                        <span>
                          {formatDateTime(m.createdAt)} · {isSource ? '并入' : '吸收了'}{' '}
                          <Link to={`/f/${fid}/people/${otherId}`}>
                            {isSource ? m.targetName : m.sourceName}
                          </Link>
                          ，涉及 {m.itemCount} 条关联
                        </span>
                        {canManage && !m.undone && isSource ? (
                          <Button size="sm" loading={undo.isPending} onClick={() => undo.mutate(m.id)}>
                            撤销
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

      {editOpen ? (
        <PersonEditDialog
          fid={fid!}
          person={person}
          open={editOpen}
          onClose={() => setEditOpen(false)}
        />
      ) : null}
      {mergeOpen ? (
        <MergeDialog
          fid={fid!}
          source={person}
          people={peopleQuery.data?.people ?? []}
          open={mergeOpen}
          onClose={() => setMergeOpen(false)}
          onMerged={(targetId) => {
            setMergeOpen(false);
            navigate(`/f/${fid}/people/${targetId}`);
          }}
        />
      ) : null}
    </div>
  );
}
