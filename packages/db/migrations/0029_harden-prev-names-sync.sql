CREATE OR REPLACE FUNCTION sync_ch_previous_names() RETURNS trigger AS $$
BEGIN
	-- Skip no-op assignments: UPDATE OF fires whenever the column is in the
	-- SET list (every stream/seed upsert does this), not when the value changed
	IF TG_OP = 'UPDATE' THEN
		IF OLD.previous_company_names IS NOT DISTINCT FROM NEW.previous_company_names THEN
			RETURN NEW;
		END IF;
	END IF;
	DELETE FROM ch_previous_names WHERE company_number = NEW.company_number;
	-- n IS NOT NULL: a NULL array element would violate name NOT NULL and
	-- abort the parent profile write (poison event wedging the stream listener)
	INSERT INTO ch_previous_names (company_number, name)
	SELECT DISTINCT NEW.company_number, n FROM unnest(NEW.previous_company_names) AS n
	WHERE n IS NOT NULL
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END $$ LANGUAGE plpgsql;
