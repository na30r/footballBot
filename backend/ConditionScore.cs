sealed record GoalMark(int Minute, string Label, string Side, string Player, bool FirstHalf);

static class ConditionScore
{
    public static (int Goals, string Outcome) From(MatchDetail detail) =>
        InWindow(30, HalfTimeTotal(detail), Goals(detail));

    public static int? HalfTimeTotal(MatchDetail detail) =>
        TryHalfTimeGoals(detail.HalfTime, out var goals) ? goals : null;

    public static IReadOnlyList<GoalMark> Goals(MatchDetail detail)
    {
        var marks = new List<GoalMark>();
        foreach (var item in detail.Events)
        {
            if (!IsGoal(item.Type))
                continue;

            var minute = LeadingMinute(item.Minute);
            if (minute is not int value)
                continue;

            var label = string.IsNullOrWhiteSpace(item.Minute) ? value.ToString() : item.Minute.Trim();
            marks.Add(new GoalMark(value, label, item.Side ?? "", item.Text ?? "", value <= 45));
        }

        return marks;
    }

    public static (int Goals, string Outcome) InWindow(int fromMinute, int? halfTimeGoals, IReadOnlyList<GoalMark> goals)
    {
        var firstHalf = goals.Where(goal => goal.FirstHalf).ToArray();
        if (halfTimeGoals is int total)
        {
            var before = firstHalf.Count(goal => goal.Minute < fromMinute);
            var counted = Math.Max(0, total - before);
            return (counted, OutcomeFor(counted));
        }

        var timed = firstHalf.Count(goal => goal.Minute >= fromMinute);
        return (timed, OutcomeFor(timed));
    }

    public static string OutcomeFor(int goals) => goals switch
    {
        0 => "win",
        1 => "draw",
        _ => "lose"
    };

    public static DateOnly PlayedOn(DateTimeOffset? kickoff)
    {
        var moment = kickoff ?? DateTimeOffset.UtcNow;
        var local = TimeZoneInfo.ConvertTime(moment, IranTime);
        return DateOnly.FromDateTime(local.DateTime);
    }

    static bool IsGoal(string type)
    {
        if (!type.Contains("goal", StringComparison.OrdinalIgnoreCase))
            return false;

        return !type.Contains("disallow", StringComparison.OrdinalIgnoreCase)
            && !type.Contains("cancel", StringComparison.OrdinalIgnoreCase)
            && !type.Contains("miss", StringComparison.OrdinalIgnoreCase);
    }

    static int? LeadingMinute(string? minute)
    {
        if (string.IsNullOrWhiteSpace(minute))
            return null;

        var digits = new string(minute.TakeWhile(char.IsDigit).ToArray());
        return int.TryParse(digits, out var value) ? value : null;
    }

    static bool TryHalfTimeGoals(string? halfTime, out int goals)
    {
        goals = 0;
        if (string.IsNullOrWhiteSpace(halfTime))
            return false;

        var parts = halfTime.Split(['–', '-', ':'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length < 2 || !int.TryParse(parts[0], out var home) || !int.TryParse(parts[1], out var away))
            return false;

        goals = home + away;
        return true;
    }

    static TimeZoneInfo IranTime { get; } = TimeZoneInfo.FindSystemTimeZoneById("Iran Standard Time");
}
