import argparse
import json
import time
import urllib.request
from collections import Counter
from pathlib import Path

import pandas as pd


DEFAULT_SOURCE = "/Users/stephaniechen/Downloads/df_output.csv"
OUTPUT_PATH = Path("data/risk-dashboard.json")
IP_CACHE_PATH = Path("data/ip-location-cache.json")


def load_ip_cache():
    if not IP_CACHE_PATH.exists():
        return {}
    try:
        return json.loads(IP_CACHE_PATH.read_text(encoding="utf8"))
    except json.JSONDecodeError:
        return {}


def save_ip_cache(cache):
    IP_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    IP_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def lookup_ip(ip, cache, delay_seconds=1.5):
    if not ip or str(ip).strip().lower() in {"unknown", "nan", "none", "null", "<na>"}:
        return "Unknown"
    if ip in cache:
        return cache[ip]

    location = "Unknown"
    try:
        url = f"http://ip-api.com/json/{ip}?lang=zh-CN"
        with urllib.request.urlopen(url, timeout=5) as response:
            data = json.loads(response.read().decode())
            if data.get("status") == "success":
                parts = [data.get("country"), data.get("regionName"), data.get("city")]
                location = " ".join(str(part) for part in parts if part)
            else:
                location = data.get("message") or "Lookup failed"
    except Exception:
        location = "Timeout/Failed"

    cache[ip] = location
    save_ip_cache(cache)
    time.sleep(delay_seconds)
    return location


def pct(value, total):
    return round(float(value) / float(total) * 100, 2) if total else 0


def top_counts(series, n=10):
    counts = series.dropna().value_counts().head(n)
    return [{"name": str(k), "count": int(v)} for k, v in counts.items()]


def two_hour_bucket(hour):
    if pd.isna(hour):
        return "Unknown"
    start = int(hour // 2 * 2)
    end = start + 2
    return f"{start:02d}:00-{end:02d}:00"


def time_bucket_counts(series):
    labels = [f"{hour:02d}:00-{hour + 2:02d}:00" for hour in range(0, 24, 2)]
    counts = series.dropna().value_counts()
    return [{"name": label, "count": int(counts.get(label, 0))} for label in labels]


def normalize_ip(value):
    if pd.isna(value):
        return "Unknown"
    ip = str(value).strip()
    if not ip or ip.lower() in {"unknown", "nan", "none", "null", "<na>"}:
        return "Unknown"
    return ip


def normalize_group(value):
    if pd.isna(value):
        return "unknown"
    group = str(value).strip().lower()
    return group or "unknown"


def format_duration_days_hours(value):
    if pd.isna(value):
        return ""
    total_seconds = int(value.total_seconds())
    days = total_seconds // 86400
    hours = (total_seconds % 86400) // 3600
    return f"{days}天{hours}小时"


def risk_reasons(row):
    reasons = []
    if row["total_orders"] == 0:
        reasons.append("无投注记录")
        return reasons
    if row["total_profit"] > 10000:
        reasons.append("玩家净赢 > 10,000")
    if row["ip_count"] > 5:
        reasons.append("IP 数 > 5")
    if row["active_duration_seconds"] <= 86400:
        reasons.append("Active 时间 <= 1天")
    return reasons


def build_dashboard(source_path, lookup_locations=False, max_lookup_ips=120):
    columns = [
        "user_id",
        "user_name",
        "nick_name",
        "duration",
        "strategy_name",
        "bet",
        "payout",
        "profit",
        "fish_value",
        "bullet_level",
        "multiplier",
        "ip",
        "event_timestamp",
        "data_date",
        "group",
    ]
    df = pd.read_csv(source_path, usecols=lambda col: col in columns)
    for column in columns:
        if column not in df.columns:
            df[column] = pd.NA

    required_columns = ["user_id", "bet", "payout"]
    missing_required = [column for column in required_columns if df[column].isna().all()]
    if missing_required:
        raise ValueError(f"CSV 缺少必要字段或字段全为空: {missing_required}")

    df["user_id"] = df["user_id"].astype(str)
    all_users = df.groupby("user_id", dropna=False).agg(
        user_name=("user_name", "first"),
        nick_name=("nick_name", "first"),
        account_duration=("duration", "first"),
    )
    all_users["account_duration_td"] = pd.to_timedelta(all_users["account_duration"], errors="coerce")

    orders = df.dropna(subset=["bet", "payout"]).copy()
    orders["ip"] = orders["ip"].map(normalize_ip)
    orders["player_group"] = orders["group"].map(normalize_group)
    orders.loc[orders["player_group"] == "unknown", "player_group"] = (
        orders.loc[orders["player_group"] == "unknown", "strategy_name"].map(normalize_group)
    )
    orders["duration_td"] = pd.to_timedelta(orders["duration"], errors="coerce")
    orders["event_time"] = pd.to_datetime(orders["event_timestamp"], errors="coerce")
    orders["bet_time_bucket"] = orders["event_time"].dt.hour.map(two_hour_bucket)

    order_metrics = orders.groupby("user_id", dropna=False).agg(
        total_orders=("user_id", "size"),
        total_bet=("bet", "sum"),
        total_payout=("payout", "sum"),
        total_profit=("profit", "sum"),
        ip_count=("ip", "nunique"),
        active_duration=("duration_td", "max"),
        first_event_time=("event_time", "min"),
        last_event_time=("event_time", "max"),
    )
    event_span = order_metrics["last_event_time"] - order_metrics["first_event_time"]
    order_metrics["event_span_duration"] = event_span.where(event_span >= pd.Timedelta(0))
    grouped = all_users.join(order_metrics, how="left")
    grouped["total_orders"] = grouped["total_orders"].fillna(0).astype(int)
    for column in ["total_bet", "total_payout", "total_profit", "ip_count"]:
        grouped[column] = grouped[column].fillna(0)
    grouped["active_duration"] = (
        grouped["active_duration"]
        .fillna(grouped["account_duration_td"])
        .fillna(grouped["event_span_duration"])
    )
    grouped["active_duration_seconds"] = grouped["active_duration"].dt.total_seconds().fillna(0).astype(int)
    grouped["rtp"] = (grouped["total_payout"] / grouped["total_bet"] * 100).fillna(0)

    ip_counts = orders.groupby(["user_id", "ip"], dropna=True).size().rename("count").reset_index()
    top_ip_counts = ip_counts.sort_values(["user_id", "count"], ascending=[True, False]).groupby("user_id").head(1)
    grouped["top_ip"] = top_ip_counts.set_index("user_id")["ip"]
    grouped["top_ip_count"] = top_ip_counts.set_index("user_id")["count"]
    grouped["top_ip_share"] = grouped["top_ip_count"] / grouped["total_orders"] * 100
    grouped = grouped.fillna({"top_ip": "", "top_ip_count": 0, "top_ip_share": 0})

    grouped["risk_score"] = (
        (grouped["total_profit"].clip(lower=0) / 100)
        + (grouped["ip_count"] * 10)
        + ((86400 - grouped["active_duration_seconds"]).clip(lower=0) / 3600)
        + (grouped["total_orders"].clip(upper=20000) / 1000)
    )
    grouped["is_default_risk"] = (
        (grouped["total_orders"] > 0)
        & (
            (grouped["total_profit"] > 10000)
            | (grouped["ip_count"] > 5)
            | (grouped["active_duration_seconds"] <= 86400)
        )
    )
    grouped = grouped.sort_values(["is_default_risk", "risk_score", "total_profit"], ascending=False)

    cache = load_ip_cache()
    ips_to_lookup = []
    if lookup_locations:
        risk_user_ids = grouped[grouped["is_default_risk"]].index.tolist()
        risk_ips = ip_counts[ip_counts["user_id"].isin(risk_user_ids)]
        ip_counter = Counter()
        for ip, count in zip(risk_ips["ip"], risk_ips["count"]):
            ip_counter[str(ip)] += int(count)
        ips_to_lookup = [ip for ip, _ in ip_counter.most_common(max_lookup_ips)]
        for ip in ips_to_lookup:
            lookup_ip(ip, cache)

    group_order_counts = orders["player_group"].value_counts()
    preferred_groups = ["boost_pool", "dynamic_rtp_v2", "default"]
    group_columns = [group for group in preferred_groups if group in group_order_counts.index]
    for group in group_order_counts.index:
        if group not in group_columns and len(group_columns) < 3:
            group_columns.append(group)

    group_user_counts = []
    for group in group_columns:
        count = orders.loc[orders["player_group"] == group, "user_id"].nunique()
        group_user_counts.append({"name": group, "count": int(count)})

    users = []
    all_ip_counter = Counter()
    for user_id, row in grouped.iterrows():
        user_orders = orders[orders["user_id"] == user_id]
        user_ip_counts = ip_counts[ip_counts["user_id"] == user_id].sort_values("count", ascending=False)
        ip_distribution = []
        for _, ip_row in user_ip_counts.iterrows():
            ip = str(ip_row["ip"])
            count = int(ip_row["count"])
            all_ip_counter[ip] += count
            ip_distribution.append(
                {
                    "ip": ip,
                    "location": cache.get(ip, "Unknown"),
                    "count": count,
                    "share": pct(count, row["total_orders"]),
                }
            )

        group_mix = {}
        user_total_orders = len(user_orders)
        user_total_bet = float(user_orders["bet"].sum()) if not user_orders.empty else 0
        group_stats = {}
        for group in group_columns:
            group_orders = user_orders[user_orders["player_group"] == group]
            group_order_count = len(group_orders)
            group_bet = float(group_orders["bet"].sum()) if group_order_count else 0
            group_profit = float(group_orders["profit"].sum()) if group_order_count else 0
            group_stats[group] = {
                "orders": group_order_count,
                "bet": group_bet,
                "profit": group_profit,
            }

        user_profit_denominator = sum(abs(stats["profit"]) for stats in group_stats.values())
        for group, stats in group_stats.items():
            group_mix[group] = {
                "orders": int(stats["orders"]),
                "bet": round(stats["bet"], 2),
                "profit": round(stats["profit"], 2),
                "order_share": pct(stats["orders"], user_total_orders),
                "bet_share": pct(stats["bet"], user_total_bet),
                "profit_share": pct(abs(stats["profit"]), user_profit_denominator),
            }

        users.append(
            {
                "user_id": user_id,
                "user_name": "" if pd.isna(row["user_name"]) else str(row["user_name"]),
                "nick_name": "" if pd.isna(row["nick_name"]) else str(row["nick_name"]),
                "total_orders": int(row["total_orders"]),
                "total_bet": round(float(row["total_bet"]), 2),
                "total_payout": round(float(row["total_payout"]), 2),
                "total_profit": round(float(row["total_profit"]), 2),
                "rtp": round(float(row["rtp"]), 2),
                "active_duration_exact": str(row["active_duration"]) if not pd.isna(row["active_duration"]) else "",
                "active_duration_days_hours": format_duration_days_hours(row["active_duration"]),
                "active_duration_seconds": int(row["active_duration_seconds"]),
                "ip_count": int(row["ip_count"]),
                "top_ip": str(row["top_ip"]),
                "top_ip_share": round(float(row["top_ip_share"]), 2),
                "risk_score": round(float(row["risk_score"]), 2),
                "default_risk": bool(row["is_default_risk"]),
                "risk_reasons": risk_reasons(row),
                "ip_distribution": ip_distribution,
                "group_mix": group_mix,
                "strategy_distribution": top_counts(user_orders["strategy_name"], 8),
                "bullet_distribution": top_counts(user_orders["bullet_level"], 10),
                "fish_distribution": top_counts(user_orders["fish_value"], 10),
                "multiplier_distribution": top_counts(user_orders["multiplier"], 8),
                "bet_time_distribution": time_bucket_counts(user_orders["bet_time_bucket"]),
            }
        )

    payload = {
        "generated_at": pd.Timestamp.now(tz="America/Los_Angeles").isoformat(),
        "source_file": str(source_path),
        "order_count": int(len(orders)),
        "user_count": int(df["user_id"].nunique()),
        "active_user_count": int(orders["user_id"].nunique()),
        "ip_count": int(orders["ip"].nunique()),
        "group_columns": group_columns,
        "group_user_counts": group_user_counts,
        "default_filters": {
            "min_orders": 0,
            "min_profit": 10000,
            "min_ip_count": 5,
            "max_active_hours": 24,
            "min_top_ip_share": 0,
        },
        "ip_lookup": {
            "provider": "ip-api.com",
            "language": "zh-CN",
            "looked_up_count": len(ips_to_lookup),
            "cached_count": len(cache),
        },
        "top_ips": [
            {"ip": ip, "location": cache.get(ip, "Unknown"), "count": count}
            for ip, count in all_ip_counter.most_common(30)
        ],
        "users": users,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    return payload


def main():
    parser = argparse.ArgumentParser(description="Build risk-player dashboard data from df_output.csv.")
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--lookup-ips", action="store_true", help="Use ip-api.com to resolve risk-player IP locations.")
    parser.add_argument("--max-lookup-ips", type=int, default=120)
    args = parser.parse_args()

    payload = build_dashboard(args.source, args.lookup_ips, args.max_lookup_ips)
    print(
        f"Built {OUTPUT_PATH} with {payload['user_count']} users, "
        f"{payload['order_count']} orders, {payload['ip_count']} IPs."
    )


if __name__ == "__main__":
    main()
