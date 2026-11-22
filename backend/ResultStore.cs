using Npgsql;
using NpgsqlTypes;

sealed class ResultStore
{
    readonly NpgsqlDataSource? _dataSource;
    bool _ready;

    public ResultStore(string? connectionString)
    {
        if (!string.IsNullOrWhiteSpace(connectionString))
            _dataSource = NpgsqlDataSource.Create(connectionString);
    }

    public bool Enabled => _dataSource is not null;

    public async Task<HashSet<string>> LoadKnownSlugs(CancellationToken cancellationToken)
    {
        await EnsureSchema(cancellationToken);
        return await LoadSlugs(cancellationToken);
    }

    public async Task Save(
        MatchItem match,
        DateOnly playedOn,
        int goals,
        string outcome,
        int? halfTimeGoals,
        IReadOnlyList<GoalMark> marks,
        CancellationToken cancellationToken)
    {
        await EnsureSchema(cancellationToken);
        await Insert(match, playedOn, goals, outcome, halfTimeGoals, marks, cancellationToken);
    }

    public async Task<IReadOnlyList<string>> Days(CancellationToken cancellationToken)
    {
        if (_dataSource is null)
            return [];

        await EnsureSchema(cancellationToken);
        var days = new List<string>();
        await using var command = _dataSource.CreateCommand("""
            SELECT DISTINCT played_on::text
            FROM match_conditions
            WHERE goals_stored
            ORDER BY 1 DESC
            """);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            days.Add(reader.GetString(0));
        return days;
    }

    public async Task<RangeReport> Range(string? league, DateOnly playedOn, int fromMinute, CancellationToken cancellationToken)
    {
        if (_dataSource is null)
            return new RangeReport(playedOn.ToString("yyyy-MM-dd"), league ?? "all", fromMinute, 0, 0, 0, []);

        await EnsureSchema(cancellationToken);
        var leagueId = string.IsNullOrWhiteSpace(league) || league == "all" ? "" : league.Trim();
        var stored = new List<StoredMatch>();
        await using (var command = _dataSource.CreateCommand("""
            SELECT slug, league, home, away, home_score, away_score, ht_goals
            FROM match_conditions
            WHERE played_on = $1
              AND goals_stored
              AND ($2 = '' OR league_id = $2)
            ORDER BY kickoff NULLS LAST, home
            """))
        {
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Date, Value = playedOn });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = leagueId });
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                stored.Add(new StoredMatch(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.IsDBNull(5) ? null : reader.GetString(5),
                    reader.IsDBNull(6) ? null : reader.GetInt32(6)));
            }
        }

        var marks = await LoadGoals(stored.Select(match => match.Slug).ToArray(), cancellationToken);
        var rows = new List<RangeMatch>();
        var wins = 0;
        var losses = 0;
        var draws = 0;
        foreach (var match in stored)
        {
            var goals = marks.TryGetValue(match.Slug, out var matchGoals) ? matchGoals : [];
            var (count, outcome) = ConditionScore.InWindow(fromMinute, match.HalfTimeGoals, goals);
            if (outcome == "win") wins++;
            else if (outcome == "lose") losses++;
            else draws++;

            var shown = goals
                .Where(goal => goal.FirstHalf && goal.Minute >= fromMinute)
                .Select(goal => new GoalView(goal.Label, goal.Player))
                .ToArray();
            rows.Add(new RangeMatch(
                match.Slug,
                match.Home,
                match.Away,
                match.League,
                match.HomeScore,
                match.AwayScore,
                count,
                outcome,
                shown));
        }

        return new RangeReport(playedOn.ToString("yyyy-MM-dd"), leagueId == "" ? "all" : leagueId, fromMinute, wins, losses, draws, rows);
    }

    public async Task<ConditionReport> Report(CancellationToken cancellationToken)
    {
        if (_dataSource is null)
            return new ConditionReport([], [], false);

        await EnsureSchema(cancellationToken);

        var days = new List<DayStat>();
        await using (var command = _dataSource.CreateCommand("""
            SELECT played_on::text,
                   COUNT(*) FILTER (WHERE outcome = 'win')::int,
                   COUNT(*) FILTER (WHERE outcome = 'lose')::int,
                   COUNT(*) FILTER (WHERE outcome = 'draw')::int
            FROM match_conditions
            GROUP BY played_on
            ORDER BY played_on DESC
            """))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
                days.Add(new DayStat(reader.GetString(0), reader.GetInt32(1), reader.GetInt32(2), reader.GetInt32(3)));
        }

        var matches = new List<MatchCondition>();
        await using (var command = _dataSource.CreateCommand("""
            SELECT slug, home, away, league, played_on::text, goals, outcome
            FROM match_conditions
            ORDER BY played_on DESC, kickoff DESC
            """))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                matches.Add(new MatchCondition(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    reader.GetString(4),
                    reader.GetInt32(5),
                    reader.GetString(6)));
            }
        }

        return new ConditionReport(days, matches, true);
    }

    async Task EnsureSchema(CancellationToken cancellationToken)
    {
        if (_ready || _dataSource is null)
            return;

        await using var command = _dataSource.CreateCommand("""
            CREATE TABLE IF NOT EXISTS match_conditions (
                slug text PRIMARY KEY,
                league text NOT NULL,
                home text NOT NULL,
                away text NOT NULL,
                kickoff timestamptz NULL,
                played_on date NOT NULL,
                goals integer NOT NULL,
                outcome text NOT NULL CHECK (outcome IN ('win', 'draw', 'lose')),
                recorded_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS match_conditions_played_on ON match_conditions (played_on);
            ALTER TABLE match_conditions ADD COLUMN IF NOT EXISTS league_id text NOT NULL DEFAULT '';
            ALTER TABLE match_conditions ADD COLUMN IF NOT EXISTS home_score text NULL;
            ALTER TABLE match_conditions ADD COLUMN IF NOT EXISTS away_score text NULL;
            ALTER TABLE match_conditions ADD COLUMN IF NOT EXISTS ht_goals integer NULL;
            ALTER TABLE match_conditions ADD COLUMN IF NOT EXISTS goals_stored boolean NOT NULL DEFAULT false;
            CREATE TABLE IF NOT EXISTS match_goals (
                id bigserial PRIMARY KEY,
                slug text NOT NULL REFERENCES match_conditions(slug) ON DELETE CASCADE,
                minute integer NOT NULL,
                label text NOT NULL,
                side text NOT NULL DEFAULT '',
                player text NOT NULL DEFAULT '',
                first_half boolean NOT NULL
            );
            CREATE INDEX IF NOT EXISTS match_goals_slug ON match_goals (slug);
            """);
        await command.ExecuteNonQueryAsync(cancellationToken);
        _ready = true;
    }

    async Task<HashSet<string>> LoadSlugs(CancellationToken cancellationToken)
    {
        var slugs = new HashSet<string>(StringComparer.Ordinal);
        await using var command = _dataSource!.CreateCommand("SELECT slug FROM match_conditions WHERE goals_stored");
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            slugs.Add(reader.GetString(0));
        return slugs;
    }

    async Task<Dictionary<string, List<GoalMark>>> LoadGoals(string[] slugs, CancellationToken cancellationToken)
    {
        var marks = new Dictionary<string, List<GoalMark>>(StringComparer.Ordinal);
        if (slugs.Length == 0)
            return marks;

        await using var command = _dataSource!.CreateCommand("""
            SELECT slug, minute, label, side, player, first_half
            FROM match_goals
            WHERE slug = ANY($1)
            ORDER BY minute, id
            """);
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text, Value = slugs });
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var slug = reader.GetString(0);
            if (!marks.TryGetValue(slug, out var list))
            {
                list = [];
                marks[slug] = list;
            }

            list.Add(new GoalMark(
                reader.GetInt32(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetBoolean(5)));
        }

        return marks;
    }

    async Task Insert(
        MatchItem match,
        DateOnly playedOn,
        int goals,
        string outcome,
        int? halfTimeGoals,
        IReadOnlyList<GoalMark> marks,
        CancellationToken cancellationToken)
    {
        await using var connection = await _dataSource!.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var command = new NpgsqlCommand("""
            INSERT INTO match_conditions (
                slug, league_id, league, home, away, home_score, away_score, kickoff, played_on, ht_goals, goals, outcome, goals_stored)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
            ON CONFLICT (slug) DO UPDATE SET
                league_id = EXCLUDED.league_id,
                league = EXCLUDED.league,
                home = EXCLUDED.home,
                away = EXCLUDED.away,
                home_score = EXCLUDED.home_score,
                away_score = EXCLUDED.away_score,
                kickoff = EXCLUDED.kickoff,
                played_on = EXCLUDED.played_on,
                ht_goals = EXCLUDED.ht_goals,
                goals = EXCLUDED.goals,
                outcome = EXCLUDED.outcome,
                goals_stored = true,
                recorded_at = now()
            """, connection, transaction))
        {
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = match.Slug! });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = match.LeagueId });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = match.Competition });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = match.Home });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = match.Away });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)match.HomeScore ?? DBNull.Value });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)match.AwayScore ?? DBNull.Value });
            command.Parameters.Add(new NpgsqlParameter
            {
                NpgsqlDbType = NpgsqlDbType.TimestampTz,
                Value = match.Kickoff.HasValue ? match.Kickoff.Value : DBNull.Value
            });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Date, Value = playedOn });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Integer, Value = halfTimeGoals.HasValue ? halfTimeGoals.Value : DBNull.Value });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Integer, Value = goals });
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = outcome });
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var delete = new NpgsqlCommand("DELETE FROM match_goals WHERE slug = $1", connection, transaction))
        {
            delete.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = match.Slug! });
            await delete.ExecuteNonQueryAsync(cancellationToken);
        }

        foreach (var mark in marks)
        {
            await using var insert = new NpgsqlCommand("""
                INSERT INTO match_goals (slug, minute, label, side, player, first_half)
                VALUES ($1, $2, $3, $4, $5, $6)
                """, connection, transaction);
            insert.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = match.Slug! });
            insert.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Integer, Value = mark.Minute });
            insert.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = mark.Label });
            insert.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = mark.Side });
            insert.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = mark.Player });
            insert.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Boolean, Value = mark.FirstHalf });
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
    }

    public static bool IsFinished(string status)
    {
        var value = status.ToLowerInvariant().Replace(" ", "").Replace("_", "").Replace("-", "");
        return value is "finished" or "ft" or "aet" or "pen" or "ended" or "closed";
    }
}

sealed record ConditionReport(IReadOnlyList<DayStat> Days, IReadOnlyList<MatchCondition> Matches, bool Ready);

sealed record DayStat(string Date, int Wins, int Losses, int Draws);

sealed record MatchCondition(string Slug, string Home, string Away, string League, string Date, int Goals, string Outcome);

sealed record RangeReport(
    string Date,
    string League,
    int FromMinute,
    int Wins,
    int Losses,
    int Draws,
    IReadOnlyList<RangeMatch> Matches);

sealed record RangeMatch(
    string Slug,
    string Home,
    string Away,
    string League,
    string? HomeScore,
    string? AwayScore,
    int Goals,
    string Outcome,
    IReadOnlyList<GoalView> Minutes);

sealed record GoalView(string Label, string Player);

sealed record StoredMatch(
    string Slug,
    string League,
    string Home,
    string Away,
    string? HomeScore,
    string? AwayScore,
    int? HalfTimeGoals);
