using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.FileProviders;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

builder.Services.AddMemoryCache();
builder.Services.AddSingleton(new ResultStore(builder.Configuration["Postgres:ConnectionString"]));
builder.Services.AddHttpClient("sportscore", client =>
{
    client.BaseAddress = new Uri("https://sportscore.com/");
    client.Timeout = TimeSpan.FromSeconds(15);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("FootballLiveDemo/1.0");
});
builder.Services.AddHttpClient("telegram", client =>
{
    client.BaseAddress = new Uri("https://api.telegram.org/");
    client.Timeout = TimeSpan.FromSeconds(20);
});

var app = builder.Build();

var frontendDist = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "frontend", "dist"));
PhysicalFileProvider? frontendFiles = Directory.Exists(frontendDist)
    ? new PhysicalFileProvider(frontendDist)
    : null;

if (frontendFiles is not null)
{
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = frontendFiles });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = frontendFiles });
}

app.Use(async (context, next) =>
{
    var accept = context.Request.Headers.Accept.ToString();
    if (context.Request.Path.StartsWithSegments("/api")
        && accept.Contains("text/html", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.Redirect("/");
        return;
    }

    await next();
});

app.MapGet("/api/matches", async (
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    CancellationToken cancellationToken) =>
{
    try
    {
        var feed = await LoadMatchFeed(httpFactory, cache, cancellationToken);
        return feed is null
            ? Results.Json(new { error = "The football feed is unavailable right now." }, statusCode: StatusCodes.Status502BadGateway)
            : Results.Ok(feed);
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.Json(
            new { error = "Could not reach the football feed." },
            statusCode: StatusCodes.Status502BadGateway);
    }
});

app.MapPost("/api/telegram", async (
    HttpRequest request,
    IConfiguration configuration,
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    CancellationToken cancellationToken) =>
{
    string? text = null;
    if (request.ContentLength is > 0)
    {
        var message = await request.ReadFromJsonAsync<TelegramMessage>(cancellationToken);
        text = message?.Text;
    }

    if (!string.IsNullOrWhiteSpace(text))
    {
        var sent = await DeliverTelegram(configuration, httpFactory, text, cancellationToken);
        return sent
            ? Results.Ok(new { sent = true, count = 1 })
            : Results.Json(
                new { error = "Telegram did not accept the message. Check the bot token and that you pressed Start." },
                statusCode: StatusCodes.Status502BadGateway);
    }

    var feed = await LoadMatchFeed(httpFactory, cache, cancellationToken);
    if (feed is null)
    {
        return Results.Json(
            new { error = "The football feed is unavailable right now." },
            statusCode: StatusCodes.Status502BadGateway);
    }

    var path = Path.Combine(app.Environment.ContentRootPath, "notified-25.json");
    var notified = LoadNotified(path);
    var result = await NotifyTwentyFifthMinute(feed, httpFactory, cache, configuration, notified, app.Logger, cancellationToken);
    if (result.Changed)
        SaveNotified(path, notified);

    return result.Sent > 0
        ? Results.Ok(new { sent = true, count = result.Sent })
        : Results.Ok(new { sent = false, count = 0 });
});

app.MapGet("/api/days", async (ResultStore store, CancellationToken cancellationToken) =>
{
    try
    {
        return Results.Ok(await store.Days(cancellationToken));
    }
    catch (Exception ex) when (ex is NpgsqlException or TimeoutException)
    {
        return Results.Json(
            new { error = "The results database is unavailable." },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapGet("/api/range", async (string? league, string? date, int? from, ResultStore store, CancellationToken cancellationToken) =>
{
    if (!DateOnly.TryParse(date, out var playedOn))
        return Results.BadRequest(new { error = "Pick a day." });

    var start = Math.Clamp(from ?? 29, 0, 45);
    try
    {
        return Results.Ok(await store.Range(league, playedOn, start, cancellationToken));
    }
    catch (Exception ex) when (ex is NpgsqlException or TimeoutException)
    {
        return Results.Json(
            new { error = "The results database is unavailable." },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapGet("/api/conditions", async (ResultStore store, CancellationToken cancellationToken) =>
{
    try
    {
        return Results.Ok(await store.Report(cancellationToken));
    }
    catch (Exception ex) when (ex is NpgsqlException or TimeoutException)
    {
        return Results.Json(
            new { error = "The results database is unavailable." },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapGet("/api/match/{slug}", async (
    string slug,
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    CancellationToken cancellationToken) =>
{
    if (!IsSlug(slug))
        return Results.NotFound(new { error = "Match not found." });

    try
    {
        var detail = await LoadMatchDetail(slug, httpFactory, cache, cancellationToken);
        return detail is null
            ? Results.NotFound(new { error = "Match not found." })
            : Results.Ok(detail);
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.Json(
            new { error = "Could not reach the football feed." },
            statusCode: StatusCodes.Status502BadGateway);
    }
});

if (frontendFiles is not null)
    app.MapFallback(() => Results.File(Path.Combine(frontendDist, "index.html"), "text/html"));

_ = WatchTwentyFifthMinute(app.Services, app.Lifetime.ApplicationStopping);

app.Run();

static async Task<MatchDetail?> LoadMatchDetail(
    string slug,
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    CancellationToken cancellationToken)
{
    var cacheKey = $"match-detail:{slug}";
    if (cache.TryGetValue(cacheKey, out MatchDetail? cached) && cached is not null)
        return cached;

    var client = httpFactory.CreateClient("sportscore");
    using var response = await client.GetAsync(
        $"api/widget/match/?sport=football&slug={Uri.EscapeDataString(slug)}&src=local-football-board",
        cancellationToken);

    if (!response.IsSuccessStatusCode)
        return null;

    var payload = await response.Content.ReadFromJsonAsync<UpstreamDetail>(cancellationToken);
    if (payload?.Match is null)
        return null;

    var detail = MapDetail(slug, payload.Match);
    cache.Set(cacheKey, detail, TimeSpan.FromSeconds(15));
    return detail;
}

static async Task<MatchFeed?> LoadMatchFeed(
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    CancellationToken cancellationToken)
{
    const string cacheKey = "football-matches:top-leagues";
    if (cache.TryGetValue(cacheKey, out MatchFeed? cached) && cached is not null)
        return cached;

    var client = httpFactory.CreateClient("sportscore");
    var today = DateTime.UtcNow.Date;
    var requests = TopLeagues.All.SelectMany(league =>
        Enumerable.Range(-1, 5).Select(offset =>
            FetchLeagueDay(client, league, today.AddDays(offset), cancellationToken)));

    var results = await Task.WhenAll(requests);
    if (results.All(result => !result.Ok))
        return null;

    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var matches = new List<MatchItem>();
    foreach (var match in results.SelectMany(result => result.Matches))
    {
        var key = $"{match.LeagueId}|{match.Home}|{match.Away}|{match.Kickoff:O}";
        if (seen.Add(key))
            matches.Add(match);
    }

    matches.Sort(static (left, right) =>
    {
        var leagueCompare = LeagueRank(left.LeagueId).CompareTo(LeagueRank(right.LeagueId));
        if (leagueCompare != 0)
            return leagueCompare;

        var statusCompare = StatusRank(left.Status).CompareTo(StatusRank(right.Status));
        if (statusCompare != 0)
            return statusCompare;

        return Nullable.Compare(left.Kickoff, right.Kickoff);
    });

    var feed = new MatchFeed(
        matches.Count,
        DateTimeOffset.UtcNow,
        TopLeagues.All.Select(league => new LeagueOption(league.Id, league.Name)).ToArray(),
        matches);

    cache.Set(cacheKey, feed, TimeSpan.FromSeconds(60));
    return feed;
}

static async Task<bool> DeliverTelegram(
    IConfiguration configuration,
    IHttpClientFactory httpFactory,
    string text,
    CancellationToken cancellationToken)
{
    var token = configuration["Telegram:BotToken"]?.Trim();
    var chatId = configuration["Telegram:ChatId"]?.Trim();
    if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(chatId))
        return false;

    var client = httpFactory.CreateClient("telegram");
    using var response = await client.PostAsJsonAsync(
        new Uri($"https://api.telegram.org/bot{token}/sendMessage"),
        new { chat_id = chatId, text, parse_mode = "HTML", disable_web_page_preview = true },
        cancellationToken);

    return response.IsSuccessStatusCode;
}

static async Task WatchTwentyFifthMinute(IServiceProvider services, CancellationToken stopping)
{
    var http = services.GetRequiredService<IHttpClientFactory>();
    var cache = services.GetRequiredService<IMemoryCache>();
    var config = services.GetRequiredService<IConfiguration>();
    var logger = services.GetRequiredService<ILoggerFactory>().CreateLogger("Minute25");
    var results = services.GetRequiredService<ResultStore>();
    var path = Path.Combine(services.GetRequiredService<IHostEnvironment>().ContentRootPath, "notified-25.json");
    var notified = LoadNotified(path);

    while (!stopping.IsCancellationRequested)
    {
        try
        {
            notified = LoadNotified(path);
            var feed = await LoadMatchFeed(http, cache, stopping);
            if (feed is not null)
            {
                await RecordFinishedConditions(feed, http, cache, results, logger, stopping);
                var result = await NotifyTwentyFifthMinute(feed, http, cache, config, notified, logger, stopping);
                if (result.Changed)
                    SaveNotified(path, notified);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
        }

        try
        {
            await Task.Delay(TimeSpan.FromSeconds(15), stopping);
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}

static async Task RecordFinishedConditions(
    MatchFeed feed,
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    ResultStore results,
    ILogger logger,
    CancellationToken cancellationToken)
{
    if (!results.Enabled)
        return;

    try
    {
        var known = await results.LoadKnownSlugs(cancellationToken);
        foreach (var match in feed.Matches)
        {
            if (!ResultStore.IsFinished(match.Status) || string.IsNullOrWhiteSpace(match.Slug) || known.Contains(match.Slug))
                continue;

            try
            {
                var detail = await LoadMatchDetail(match.Slug, httpFactory, cache, cancellationToken);
                if (detail is null || !ResultStore.IsFinished(detail.Status))
                    continue;

                var marks = ConditionScore.Goals(detail);
                var halfTimeGoals = ConditionScore.HalfTimeTotal(detail);
                var (goals, outcome) = ConditionScore.InWindow(30, halfTimeGoals, marks);
                await results.Save(
                    match,
                    ConditionScore.PlayedOn(match.Kickoff),
                    goals,
                    outcome,
                    halfTimeGoals,
                    marks,
                    cancellationToken);
                known.Add(match.Slug);
                logger.LogInformation(
                    "Recorded {Outcome} for {Home} vs {Away}: {Goals} goal(s) from 30' to half-time",
                    outcome,
                    match.Home,
                    match.Away,
                    goals);
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning(ex, "Could not record {Home} vs {Away}", match.Home, match.Away);
            }
        }
    }
    catch (Exception ex) when (ex is NpgsqlException or TimeoutException)
    {
        logger.LogWarning(ex, "Could not record finished-match conditions");
    }
}

static async Task<NotifyResult> NotifyTwentyFifthMinute(
    MatchFeed feed,
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    IConfiguration configuration,
    HashSet<string> notified,
    ILogger logger,
    CancellationToken cancellationToken)
{
    var changed = false;
    var sent = 0;
    foreach (var match in feed.Matches)
    {
        if (StatusRank(match.Status) != 0 || string.IsNullOrWhiteSpace(match.Slug) || notified.Contains(match.Slug))
            continue;

        var detail = await LoadMatchDetail(match.Slug, httpFactory, cache, cancellationToken);
        var period = $"{detail?.StatusText} {match.StatusText}".ToLowerInvariant();
        if (period.Contains("2nd") || period.Contains("second") || period.Contains("half time") || period.Contains("halftime"))
        {
            notified.Add(match.Slug);
            changed = true;
            continue;
        }

        var minute = ParseMinute(detail?.Minute);
        if (minute is null)
            continue;

        if (minute is < 25)
            continue;

        if (minute > 26)
        {
            notified.Add(match.Slug);
            changed = true;
            continue;
        }

        var text = string.Join("\n", DescribeMatch(match, detail, heading: "25'"));
        if (!await DeliverTelegram(configuration, httpFactory, text, cancellationToken))
            continue;

        notified.Add(match.Slug);
        changed = true;
        sent++;
        logger.LogInformation("Sent 25' alert for {Home} vs {Away}", match.Home, match.Away);
    }

    return new NotifyResult(changed, sent);
}

static IEnumerable<string> DescribeMatch(MatchItem match, MatchDetail? detail, string? heading)
{
    var home = detail?.HomeScore ?? match.HomeScore ?? "0";
    var away = detail?.AwayScore ?? match.AwayScore ?? "0";
    var minute = string.IsNullOrWhiteSpace(detail?.Minute) ? "" : $" · {Html(detail.Minute)}'";
    var status = string.IsNullOrWhiteSpace(detail?.StatusText) ? match.StatusText : detail.StatusText;

    if (!string.IsNullOrWhiteSpace(heading))
        yield return $"<b>{Html(heading)}</b>";

    yield return $"<b>{Html(match.Competition)}</b>";
    yield return $"{Html(match.Home)} {Html(home)}–{Html(away)} {Html(match.Away)}";
    yield return $"{Html(status)}{minute}";

    var goals = detail?.Events.Where(item => item.Type.Contains("goal", StringComparison.OrdinalIgnoreCase)).ToArray() ?? [];
    yield return "";
    yield return "<b>Scorers</b>";
    if (goals.Length == 0)
    {
        yield return "None";
    }
    else
    {
        foreach (var goal in goals)
        {
            var position = detail is null ? null : PlayerPosition(detail, goal.Text, goal.Side);
            var positionText = string.IsNullOrWhiteSpace(position) ? "" : $" ({Html(position)})";
            var when = string.IsNullOrWhiteSpace(goal.Minute) ? "" : $"{Html(goal.Minute)}' ";
            yield return $"{when}{Html(goal.Text)}{positionText}";
        }
    }

    var shotsOn = FindStat(detail, "Shots on Target");
    var shotsOff = FindStat(detail, "Shots off Target");
    var possession = FindStat(detail, "Possession");
    if (shotsOn is not null)
        yield return $"Shots on target {Html(shotsOn.Home)}–{Html(shotsOn.Away)}";
    if (shotsOff is not null)
        yield return $"Shots off target {Html(shotsOff.Home)}–{Html(shotsOff.Away)}";
    if (possession is not null)
        yield return $"Possession {Html(possession.Home)}{Html(possession.Suffix)}–{Html(possession.Away)}{Html(possession.Suffix)}";
}

static MatchStat? FindStat(MatchDetail? detail, string label) =>
    detail?.Stats.FirstOrDefault(stat => stat.Label.Contains(label, StringComparison.OrdinalIgnoreCase));

static string? PlayerPosition(MatchDetail detail, string name, string side)
{
    if (detail.Lineup is null || string.IsNullOrWhiteSpace(name))
        return null;

    var players = side.Equals("away", StringComparison.OrdinalIgnoreCase)
        ? detail.Lineup.AwayXi.Concat(detail.Lineup.AwayBench)
        : detail.Lineup.HomeXi.Concat(detail.Lineup.HomeBench);

    var player = players.FirstOrDefault(item => item.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
    return player?.Position switch
    {
        "G" => "Goalkeeper",
        "D" => "Defender",
        "M" => "Midfielder",
        "F" => "Forward",
        null or "" => null,
        var other => other
    };
}

static int? ParseMinute(string? minute)
{
    if (string.IsNullOrWhiteSpace(minute))
        return null;

    var digits = new string(minute.TakeWhile(char.IsDigit).ToArray());
    return int.TryParse(digits, out var value) ? value : null;
}

static HashSet<string> LoadNotified(string path)
{
    try
    {
        if (!File.Exists(path))
            return new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var slugs = JsonSerializer.Deserialize<List<string>>(File.ReadAllText(path)) ?? [];
        return new HashSet<string>(slugs, StringComparer.OrdinalIgnoreCase);
    }
    catch (Exception ex) when (ex is IOException or JsonException)
    {
        return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    }
}

static void SaveNotified(string path, HashSet<string> notified)
{
    File.WriteAllText(path, JsonSerializer.Serialize(notified.OrderBy(slug => slug).ToArray()));
}

static string Html(string? value) => (value ?? "")
    .Replace("&", "&amp;", StringComparison.Ordinal)
    .Replace("<", "&lt;", StringComparison.Ordinal)
    .Replace(">", "&gt;", StringComparison.Ordinal);

static async Task<LeagueDay> FetchLeagueDay(
    HttpClient client,
    LeagueSource league,
    DateTime date,
    CancellationToken cancellationToken)
{
    var url =
        $"api/v1/fixtures/?sport=football&competition={league.Slug}&date={date:yyyy-MM-dd}&limit=20&src=local-football-board";

    using var response = await client.GetAsync(url, cancellationToken);
    if (!response.IsSuccessStatusCode)
        return new LeagueDay(false, []);

    var payload = await response.Content.ReadFromJsonAsync<UpstreamFeed>(cancellationToken);
    var matches = payload?.Matches.Select(match => MapMatch(match, league)).ToArray() ?? [];
    return new LeagueDay(true, matches);
}

static int LeagueRank(string leagueId)
{
    for (var index = 0; index < TopLeagues.All.Length; index++)
    {
        if (TopLeagues.All[index].Id == leagueId)
            return index;
    }

    return TopLeagues.All.Length;
}

static int StatusRank(string status)
{
    var value = status.ToLowerInvariant().Replace(" ", "").Replace("_", "").Replace("-", "");
    if (value is "live" or "inplay" or "inprogress" or "playing" or "halftime" or "ht" or "paused")
        return 0;
    if (value is "upcoming" or "scheduled" or "notstarted" or "ns" or "postponed" or "cancelled" or "canceled" or "delayed")
        return 1;
    return 2;
}

static MatchItem MapMatch(UpstreamMatch match, LeagueSource league) => new(
    league.Id,
    match.Home ?? "Home",
    match.Away ?? "Away",
    match.HomeLogo,
    match.AwayLogo,
    ReadScore(match.HomeScore),
    ReadScore(match.AwayScore),
    match.Status ?? "unknown",
    string.IsNullOrWhiteSpace(match.StatusText) ? match.Status ?? "Unknown" : match.StatusText,
    match.Time,
    league.Name,
    match.CompetitionLogo,
    ReadSlug(match.Url));

static string? ReadSlug(string? url)
{
    if (string.IsNullOrWhiteSpace(url))
        return null;

    var parts = url.Split('/', StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length >= 3 && parts[0] == "football" && parts[1] == "match")
        return parts[2];

    return null;
}

static MatchDetail MapDetail(string slug, UpstreamMatchDetail match)
{
    var events = match.Incidents.Select(MapEvent).Where(item => item is not null).Cast<MatchEvent>().ToArray();
    var stats = match.Stats.Select(MapStat).Where(item => item is not null).Cast<MatchStat>().ToArray();
    LineupSide? lineup = match.Lineups is null
        ? null
        : new LineupSide(
            match.Lineups.HomeFormation,
            match.Lineups.AwayFormation,
            MapPlayers(match.Lineups.HomeXi),
            MapPlayers(match.Lineups.AwayXi),
            MapPlayers(match.Lineups.HomeSubs),
            MapPlayers(match.Lineups.AwaySubs));

    return new MatchDetail(
        slug,
        string.IsNullOrWhiteSpace(match.LiveMinute) ? null : match.LiveMinute,
        match.Status ?? "unknown",
        string.IsNullOrWhiteSpace(match.StatusText) ? match.Status ?? "Unknown" : match.StatusText,
        ReadScore(match.HomeScore),
        ReadScore(match.AwayScore),
        ReadHalfTime(match),
        stats,
        events,
        lineup);
}

static string? ReadHalfTime(UpstreamMatchDetail match)
{
    var period = $"{match.Status} {match.StatusText}".ToLowerInvariant();
    var pastHalf = period.Contains("2nd") || period.Contains("half time") || period.Contains("halftime")
        || period.Contains("finished") || period.Contains("ft");
    if (!pastHalf)
        return null;

    var home = ReadScore(match.HomeHtScore);
    var away = ReadScore(match.AwayHtScore);
    return home is null || away is null ? null : $"{home}–{away}";
}

static MatchEvent? MapEvent(UpstreamIncident incident)
{
    var minute = ReadScore(incident.Time);
    if (string.IsNullOrWhiteSpace(minute) && string.IsNullOrWhiteSpace(incident.Type))
        return null;

    var text = incident.IsSub || incident.Type?.Contains("sub", StringComparison.OrdinalIgnoreCase) == true
        ? $"{incident.PlayerOut} off, {incident.PlayerIn} on".Trim(' ', ',')
        : string.IsNullOrWhiteSpace(incident.Player) ? incident.Type ?? "Event" : incident.Player;

    var score = ReadScore(incident.HomeScore) is { } home && ReadScore(incident.AwayScore) is { } away
        ? $"{home}–{away}"
        : null;

    return new MatchEvent(minute ?? "", incident.Type ?? "Event", incident.Side ?? "", text, score);
}

static MatchStat? MapStat(UpstreamStat stat)
{
    if (string.IsNullOrWhiteSpace(stat.Label))
        return null;

    var home = ReadScore(stat.Home) ?? "0";
    var away = ReadScore(stat.Away) ?? "0";
    return new MatchStat(stat.Label, home, away, ReadPercent(stat.HomePct), ReadPercent(stat.AwayPct), stat.Suffix ?? "");
}

static int? ReadPercent(JsonElement value) =>
    value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : null;

static PlayerSpot[] MapPlayers(List<UpstreamPlayer>? players) =>
    players?.Select(player => new PlayerSpot(
        player.Name ?? "Player",
        player.Number,
        player.Position,
        player.Captain)).ToArray() ?? [];

static bool IsSlug(string slug) =>
    System.Text.RegularExpressions.Regex.IsMatch(slug, "^[a-z0-9-]{1,80}$");

static string? ReadScore(JsonElement score) => score.ValueKind switch
{
    JsonValueKind.String => score.GetString(),
    JsonValueKind.Number => score.GetRawText(),
    _ => null
};

static class TopLeagues
{
    public static readonly LeagueSource[] All =
    [
        new("premier-league", "Premier League", "english-premier-league"),
        new("serie-a", "Serie A", "italian-serie-a"),
        new("bundesliga", "Bundesliga", "bundesliga"),
        new("la-liga", "La Liga", "spanish-la-liga"),
        new("champions-league", "Champions League", "uefa-champions-league"),
        new("europa-league", "Europa League", "uefa-europa-league"),
        new("afc-champions-league", "AFC Champions League Elite", "afc-champions-league-elite"),
    ];
}

sealed record NotifyResult(bool Changed, int Sent);

sealed record TelegramMessage(string? Text);

sealed record LeagueSource(string Id, string Name, string Slug);

sealed record LeagueOption(string Id, string Name);

sealed record LeagueDay(bool Ok, IReadOnlyList<MatchItem> Matches);

sealed record MatchFeed(
    int Count,
    DateTimeOffset? Updated,
    IReadOnlyList<LeagueOption> Leagues,
    IReadOnlyList<MatchItem> Matches);

sealed record MatchItem(
    string LeagueId,
    string Home,
    string Away,
    string? HomeLogo,
    string? AwayLogo,
    string? HomeScore,
    string? AwayScore,
    string Status,
    string StatusText,
    DateTimeOffset? Kickoff,
    string Competition,
    string? CompetitionLogo,
    string? Slug);

sealed class UpstreamFeed
{
    public int Count { get; set; }
    public DateTimeOffset? Updated { get; set; }
    public List<UpstreamMatch> Matches { get; set; } = [];
}

class UpstreamMatch
{
    public string? Home { get; set; }
    public string? Away { get; set; }

    [JsonPropertyName("home_logo")]
    public string? HomeLogo { get; set; }

    [JsonPropertyName("away_logo")]
    public string? AwayLogo { get; set; }

    [JsonPropertyName("home_score")]
    public JsonElement HomeScore { get; set; }

    [JsonPropertyName("away_score")]
    public JsonElement AwayScore { get; set; }

    public string? Status { get; set; }

    [JsonPropertyName("status_text")]
    public string? StatusText { get; set; }

    public DateTimeOffset? Time { get; set; }
    public string? Competition { get; set; }

    [JsonPropertyName("competition_logo")]
    public string? CompetitionLogo { get; set; }

    public string? Url { get; set; }
}

sealed record MatchDetail(
    string Slug,
    string? Minute,
    string Status,
    string StatusText,
    string? HomeScore,
    string? AwayScore,
    string? HalfTime,
    IReadOnlyList<MatchStat> Stats,
    IReadOnlyList<MatchEvent> Events,
    LineupSide? Lineup);

sealed record MatchStat(string Label, string Home, string Away, int? HomePct, int? AwayPct, string Suffix);

sealed record MatchEvent(string Minute, string Type, string Side, string Text, string? Score);

sealed record LineupSide(
    string? HomeFormation,
    string? AwayFormation,
    IReadOnlyList<PlayerSpot> HomeXi,
    IReadOnlyList<PlayerSpot> AwayXi,
    IReadOnlyList<PlayerSpot> HomeBench,
    IReadOnlyList<PlayerSpot> AwayBench);

sealed record PlayerSpot(string Name, int? Number, string? Position, bool Captain);

sealed class UpstreamDetail
{
    public UpstreamMatchDetail? Match { get; set; }
}

sealed class UpstreamMatchDetail : UpstreamMatch
{
    [JsonPropertyName("live_minute")]
    public string? LiveMinute { get; set; }

    public List<UpstreamIncident> Incidents { get; set; } = [];
    public List<UpstreamStat> Stats { get; set; } = [];
    public UpstreamLineup? Lineups { get; set; }

    [JsonPropertyName("home_ht_score")]
    public JsonElement HomeHtScore { get; set; }

    [JsonPropertyName("away_ht_score")]
    public JsonElement AwayHtScore { get; set; }
}

sealed class UpstreamIncident
{
    public JsonElement Time { get; set; }
    public string? Type { get; set; }
    public string? Side { get; set; }
    public string? Player { get; set; }

    [JsonPropertyName("is_sub")]
    public bool IsSub { get; set; }

    [JsonPropertyName("player_in")]
    public string? PlayerIn { get; set; }

    [JsonPropertyName("player_out")]
    public string? PlayerOut { get; set; }

    [JsonPropertyName("home_score")]
    public JsonElement HomeScore { get; set; }

    [JsonPropertyName("away_score")]
    public JsonElement AwayScore { get; set; }
}

sealed class UpstreamStat
{
    public string? Label { get; set; }
    public JsonElement Home { get; set; }
    public JsonElement Away { get; set; }

    [JsonPropertyName("home_pct")]
    public JsonElement HomePct { get; set; }

    [JsonPropertyName("away_pct")]
    public JsonElement AwayPct { get; set; }

    public string? Suffix { get; set; }
}

sealed class UpstreamLineup
{
    [JsonPropertyName("home_formation")]
    public string? HomeFormation { get; set; }

    [JsonPropertyName("away_formation")]
    public string? AwayFormation { get; set; }

    [JsonPropertyName("home_xi")]
    public List<UpstreamPlayer> HomeXi { get; set; } = [];

    [JsonPropertyName("away_xi")]
    public List<UpstreamPlayer> AwayXi { get; set; } = [];

    [JsonPropertyName("home_subs")]
    public List<UpstreamPlayer> HomeSubs { get; set; } = [];

    [JsonPropertyName("away_subs")]
    public List<UpstreamPlayer> AwaySubs { get; set; } = [];
}

sealed class UpstreamPlayer
{
    public string? Name { get; set; }
    public int? Number { get; set; }
    public string? Position { get; set; }
    public bool Captain { get; set; }
}
