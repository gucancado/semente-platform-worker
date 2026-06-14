-- Episódio re-atribuído (PATCH admin ou correção): derivados acompanham.
-- Órfão→workspace é no-op aqui (órfão nunca foi processado — §5.2).
CREATE OR REPLACE FUNCTION lua_propagate_workspace() RETURNS trigger AS $$
BEGIN
  IF OLD.workspace_id IS NOT NULL
     AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    UPDATE episode_chunks SET workspace_id = COALESCE(NEW.workspace_id, workspace_id)
      WHERE episode_id = NEW.id;
    UPDATE facts SET
        workspace_id = COALESCE(NEW.workspace_id, workspace_id),
        needs_review = TRUE,
        review_note = COALESCE(review_note || ' | ', '')
          || 'workspace re-atribuido de ' || OLD.workspace_id || ' em ' || NOW()::date
      WHERE episode_id = NEW.id;
    -- regras de conduta que citam fatos deste episódio ficam suspeitas
    UPDATE conduta_rules SET needs_review = TRUE
      WHERE id IN (
        SELECT crs.rule_id FROM conduta_rule_sources crs
        JOIN facts f ON f.id = crs.fact_id
        WHERE f.episode_id = NEW.id
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lua_propagate_workspace
  AFTER UPDATE OF workspace_id ON episodes
  FOR EACH ROW EXECUTE FUNCTION lua_propagate_workspace();
