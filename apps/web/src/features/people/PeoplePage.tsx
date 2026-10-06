import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button, EmptyState, Field, Spinner, TextInput } from '../../components/ui';
import { useFamily } from '../families/useFamily';
import { PersonFormModal } from './PersonFormModal';
import type { Person } from '../../api/types';

export function PeoplePage() {
  const { fid } = useParams<{ fid: string }>();
  const { data: familyData } = useFamily(fid);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const query = useQuery({
    queryKey: ['people', fid, q],
    queryFn: () => api.get<{ people: Person[] }>(`/families/${fid}/people${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    enabled: Boolean(fid),
  });

  const canWrite = familyData && ['owner', 'admin', 'editor'].includes(familyData.myRole);
  const people = query.data?.people ?? [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>人物</h1>
          <p className="page-head__sub">把「这东西是谁给的」记成人物档案，以后能反查一个人送过、留下的所有东西。</p>
        </div>
        {canWrite ? (
          <Button variant="primary" onClick={() => setOpen(true)}>
            新建人物
          </Button>
        ) : null}
      </div>

      <div className="filters">
        <div className="field search-input">
          <label className="field__label" htmlFor="people-search">
            搜索人物
          </label>
          <TextInput
            id="people-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入称呼、别名或关系"
          />
        </div>
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : people.length === 0 ? (
        <EmptyState
          icon="👵"
          title="还没有人物档案"
          description="建立人物后，在记录物品时就能直接选「是谁给的」。"
          action={canWrite ? <Button variant="primary" onClick={() => setOpen(true)}>新建第一个人物</Button> : undefined}
        />
      ) : (
        <div className="grid-cards">
          {people.map((p) => (
            <Link key={p.id} to={`/f/${fid}/people/${p.id}`} className="item-card" style={{ padding: 'var(--space-4)' }}>
              <h2>{p.name}</h2>
              {p.aliases.length > 0 ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  别名：{p.aliases.join('、')}
                </div>
              ) : null}
              <div className="item-card__meta">
                {p.relation ? <span>{p.relation}</span> : null}
                {p.birthYear ? <span>· {p.birthYear}{p.deathYear ? `–${p.deathYear}` : ''}</span> : null}
              </div>
              <p className="muted" style={{ fontSize: 13, marginTop: 'var(--space-2)', marginBottom: 0 }}>
                关联 {p.itemCount} 件物品
              </p>
            </Link>
          ))}
        </div>
      )}

      {open ? (
        <PersonFormModal
          fid={fid!}
          open={open}
          onClose={() => setOpen(false)}
          onSaved={() => void query.refetch()}
        />
      ) : null}
    </div>
  );
}
