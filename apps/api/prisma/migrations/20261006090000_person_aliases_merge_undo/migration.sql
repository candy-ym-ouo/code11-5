-- 人物档案：别名、关系描述；条目-人物关联上的关系说明
ALTER TABLE "people" ADD COLUMN "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "people" ADD COLUMN "relation_note" TEXT;
ALTER TABLE "item_people" ADD COLUMN "note" TEXT;

-- 人物合并记录：快照来源人物与关联条目，供撤销合并与历史追溯
CREATE TABLE "person_merges" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_name" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "links_snapshot" JSONB NOT NULL,
    "undone_at" TIMESTAMP(3),
    "undone_by_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_merges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "person_merges_family_id_created_at_idx" ON "person_merges"("family_id", "created_at");
CREATE INDEX "person_merges_source_id_idx" ON "person_merges"("source_id");
CREATE INDEX "person_merges_target_id_created_at_idx" ON "person_merges"("target_id", "created_at");

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
