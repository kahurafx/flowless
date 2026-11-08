-- Custom: PostGIS for the network model (GIS, Phase 2; K-02 map data). Creating an
-- extension needs a superuser or the database owner with trusted extensions; migrations
-- run as the owner (DATABASE_ADMIN_URL). Types and functions live in `public`, which both
-- runtime roles may use; `public.spatial_ref_sys` is reference data, not tenant data.
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
