-- Custom: a user belongs to exactly one organization (requirements §1). Better Auth's
-- generated schema cannot express this, so the database enforces it here; packages/auth
-- also refuses a second membership with a readable error before it reaches this index.
CREATE UNIQUE INDEX "member_user_id_unique" ON "auth"."member" ("user_id");
