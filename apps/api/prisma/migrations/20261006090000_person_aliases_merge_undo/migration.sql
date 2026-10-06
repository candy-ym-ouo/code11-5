-- 人物档案：别名、关系描述；合并快照表（支持撤销与历史追溯）
ALTER TABLE "people" ADD COLUMN "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "people" ADD COLUMN "relation_note" TEXT;

CREATE TABLE "person_merges" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "undone_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_merges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "person_merges_family_id_created_at_idx" ON "person_merges"("family_id", "created_at");
CREATE INDEX "person_merges_source_id_idx" ON "person_merges"("source_id");
CREATE INDEX "person_merges_target_id_idx" ON "person_merges"("target_id");

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "people"("id") ON DELETE CASCADE;
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "people"("id") ON DELETE CASCADE;

-- 自引用：被合并到了谁
ALTER TABLE "people" ADD CONSTRAINT "people_merged_into_id_fkey"
    FOREIGN KEY ("merged_into_id") REFERENCES "people"("id") ON DELETE SET NULL;
