-- Custom: a target for kernel tables that reference a membership (organization, user),
-- such as kernel.member_permission. Redundant with member_user_id_unique for uniqueness,
-- but a composite foreign key needs a matching constraint. Better Auth's generated schema
-- cannot declare it.
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_organization_id_user_id_unique" UNIQUE ("organization_id", "user_id");
