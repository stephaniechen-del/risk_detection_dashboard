import argparse
import json
import os
import socket
from contextlib import closing
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor
from sshtunnel import SSHTunnelForwarder


DASHBOARD_REQUIRED_COLUMNS = [
    "user_id",
    "strategy_name",
    "event_timestamp",
    "bet",
    "payout",
    "profit",
    "fish_value",
    "killed",
    "bullet_level",
    "multiplier",
    "ip",
]

REDSHIFT_COLUMNS = [
    "strategy_name",
    "currency_type",
    "event_timestamp",
    "bet",
    "payout",
    "profit",
    "fish_value",
    "killed",
    "room_id",
    "op_code",
    "bullet_level",
    "multiplier",
    "rtp_th",
    "killed_th",
    "killed_det",
    "event_id",
    "ip",
    "user_id",
    "group",
]


def load_env_file(path):
    env_path = Path(path)
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


for env_file in [
    Path(__file__).resolve().parents[1] / ".env",
    Path("/Users/stephaniechen/Documents/Playground/weekly_report_dashboard_share/.env"),
]:
    load_env_file(env_file)


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def parse_bool(value):
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def find_free_port():
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def csv_columns(source_path):
    return pd.read_csv(source_path, nrows=0).columns.astype(str).str.strip().tolist()


def extract_user_ids(source_path):
    user_ids = []
    seen = set()
    for chunk in pd.read_csv(source_path, usecols=["user_id"], chunksize=200_000):
        for user_id in chunk["user_id"].dropna().astype(str):
            if user_id not in seen:
                seen.add(user_id)
                user_ids.append(user_id)
    return user_ids


def query_redshift_users(user_ids, output_path, game_type="FM01", batch_size=500):
    redshift_host = env("REDSHIFT_HOST", required=True)
    redshift_port = int(env("REDSHIFT_PORT", "5439"))
    redshift_database = env("REDSHIFT_DATABASE", required=True)
    redshift_user = env("REDSHIFT_USER", required=True)
    redshift_password = env("REDSHIFT_PASSWORD", required=True)
    redshift_ssl = parse_bool(env("REDSHIFT_SSL", "true"))

    ssh_host = env("SSH_TUNNEL_HOST", required=True)
    ssh_port = int(env("SSH_TUNNEL_PORT", "22"))
    ssh_user = env("SSH_TUNNEL_USER", required=True)
    ssh_key_path = env("SSH_PRIVATE_KEY_PATH", required=True)
    local_port = find_free_port()

    rows_written = 0
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    wrote_header = False

    with SSHTunnelForwarder(
        (ssh_host, ssh_port),
        ssh_username=ssh_user,
        ssh_pkey=ssh_key_path,
        remote_bind_address=(redshift_host, redshift_port),
        local_bind_address=("127.0.0.1", local_port),
    ) as tunnel:
        connection = psycopg2.connect(
            host="127.0.0.1",
            port=tunnel.local_bind_port,
            dbname=redshift_database,
            user=redshift_user,
            password=redshift_password,
            sslmode="require" if redshift_ssl else "prefer",
            connect_timeout=20,
        )
        try:
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                for start in range(0, len(user_ids), batch_size):
                    batch = user_ids[start : start + batch_size]
                    placeholders = ", ".join(["%s"] * len(batch))
                    if game_type == "FM01":
                        sql = f"""
                            SELECT
                                strategy_name,
                                currency_type,
                                event_timestamp,
                                bet,
                                payout,
                                profit,
                                fish_value,
                                killed,
                                room_id,
                                op_code,
                                bullet_level,
                                multiplier,
                                rtp_th,
                                killed_th,
                                killed_det,
                                event_id,
                                ip,
                                user_id,
                                strategy_name AS "group"
                            FROM "transform-agfish-game".public.bullet
                            WHERE currency_type = 'CNY'
                              AND op_code NOT IN ('B26', 'TST', 'TSB', 'TSO')
                              AND CAST(user_id AS VARCHAR) IN ({placeholders})
                        """
                        params = batch
                    else:
                        sql = f"""
                            SELECT
                                COALESCE(trigger_type, bet_type, status, 'slot_order') AS strategy_name,
                                currency_type,
                                created_at AS event_timestamp,
                                bet_amount AS bet,
                                actual_payout AS payout,
                                actual_payout - bet_amount AS profit,
                                NULL::INTEGER AS fish_value,
                                CASE WHEN actual_payout > 0 THEN 1 ELSE 0 END AS killed,
                                NULL::VARCHAR AS room_id,
                                op_code,
                                base_bet AS bullet_level,
                                multiplier,
                                NULL::DOUBLE PRECISION AS rtp_th,
                                NULL::DOUBLE PRECISION AS killed_th,
                                NULL::DOUBLE PRECISION AS killed_det,
                                row_id AS event_id,
                                ip,
                                user_id,
                                COALESCE(trigger_type, bet_type, status, 'slot_order') AS "group"
                            FROM "slot-machine".public.fct_bet_orders
                            WHERE currency_type = 'CNY'
                              AND op_code NOT IN ('B26', 'TST', 'TSB', 'TSO')
                              AND game_id = %s
                              AND CAST(user_id AS VARCHAR) IN ({placeholders})
                        """
                        params = [game_type] + batch
                    cursor.execute(sql, params)
                    rows = cursor.fetchall()
                    if not rows:
                        continue
                    df = pd.DataFrame(rows, columns=REDSHIFT_COLUMNS)
                    df["data_date"] = pd.to_datetime(df["event_timestamp"], errors="coerce").dt.date.astype(str)
                    df.to_csv(output, mode="a", index=False, header=not wrote_header)
                    wrote_header = True
                    rows_written += len(df)
        finally:
            connection.close()

    if not wrote_header:
        pd.DataFrame(columns=REDSHIFT_COLUMNS + ["data_date"]).to_csv(output, index=False)
    return rows_written


def prepare_source(source_path, output_path, game_type="FM01"):
    columns = csv_columns(source_path)
    missing = [column for column in DASHBOARD_REQUIRED_COLUMNS if column not in columns]
    if not missing:
        return {
            "mode": "uploaded_csv",
            "source_path": str(source_path),
            "missing_columns": [],
            "user_count": None,
            "redshift_rows": None,
            "game_type": game_type,
        }

    if "user_id" not in columns:
        raise ValueError(
            "上传 CSV 缺少 dashboard 必要字段，且没有 user_id，无法从 Redshift 补全。"
        )

    user_ids = extract_user_ids(source_path)
    if not user_ids:
        raise ValueError("上传 CSV 没有可用的 user_id。")

    rows_written = query_redshift_users(user_ids, output_path, game_type=game_type)
    return {
        "mode": "redshift_fallback",
        "source_path": str(output_path),
        "missing_columns": missing,
        "user_count": len(user_ids),
        "redshift_rows": rows_written,
        "game_type": game_type,
    }


def main():
    parser = argparse.ArgumentParser(description="Choose uploaded CSV or Redshift fallback source for dashboard build.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--force-redshift", action="store_true")
    parser.add_argument("--game-type", default="FM01")
    args = parser.parse_args()

    if args.force_redshift:
        user_ids = extract_user_ids(args.source)
        if not user_ids:
            raise ValueError("没有可用的 user_id。")
        rows_written = query_redshift_users(user_ids, args.output, game_type=args.game_type)
        result = {
            "mode": "redshift_user_ids",
            "source_path": str(args.output),
            "missing_columns": [],
            "user_count": len(user_ids),
            "redshift_rows": rows_written,
            "game_type": args.game_type,
        }
    else:
        result = prepare_source(args.source, args.output, game_type=args.game_type)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
