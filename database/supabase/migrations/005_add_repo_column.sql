-- 005: Add repo column to design_space
-- Separates WHERE (repo) from WHY (project)
-- A repo is a codebase with defined architecture
-- A project is a goal that may span multiple repos
-- Both are needed for state tracking and cross-project awareness

ALTER TABLE design_space ADD COLUMN IF NOT EXISTS repo text;
CREATE INDEX IF NOT EXISTS idx_design_space_repo ON design_space(repo);

-- Add state categories for operational tracking
-- These complement existing categories (approved, rejected, inspiration, etc.)
-- state/current  — where we are now
-- state/plan     — where we're heading
-- state/blocker  — what's stopping us
-- state/retro    — how did it go
-- state/vision   — definition of done
COMMENT ON COLUMN design_space.repo IS 'Git repository name. Auto-detected from cwd/git remote. Enables per-repo state tracking and cross-project awareness.';
