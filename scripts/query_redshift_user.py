import argparse
import json
import os
import socket
from contextlib import closing
from pathlib import Path
import sys

import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor
from sshtunnel import SSHTunnelForwarder

sys.path.append(str(Path(__file__).resolve().parent))
from build_dashboard_data import build_dashboard


OUTPUT_COLUMNS = [
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


def query_user_records(user_id, game_type="FM01"):
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
                if game_type == "FM01":
                    sql = """
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
                          AND CAST(user_id AS VARCHAR) = %s
                    """
                    params = [str(user_id)]
                else:
                    sql = """
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
                          AND CAST(user_id AS VARCHAR) = %s
                          AND game_id = %s
                    """
                    params = [str(user_id), game_type]
                cursor.execute(sql, params)
                rows = cursor.fetchall()
                columns = [desc.name for desc in cursor.description]
        finally:
            connection.close()

    return {
        "user_id": str(user_id),
        "game_type": game_type,
        "table": '"transform-agfish-game".public.bullet' if game_type == "FM01" else '"slot-machine".public.fct_bet_orders',
        "filters": {
            "currency_type": "CNY",
            "excluded_op_code": ["B26", "TST", "TSB", "TSO"],
            "game_type": game_type,
        },
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
    }


def write_redshift_rows_csv(rows, output_path, columns=None):
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(rows, columns=columns)
    if not df.empty and "event_timestamp" in df.columns:
        df["data_date"] = pd.to_datetime(df["event_timestamp"], errors="coerce").dt.date.astype(str)
    df.to_csv(output, index=False)
    return output


def enrich_result(result, output_csv=None, dashboard_output=None):
    rows = result["rows"]
    if output_csv:
        write_redshift_rows_csv(rows, output_csv, result.get("columns"))
        result["redshift_csv"] = str(output_csv)

    if dashboard_output and output_csv and rows:
        result["dashboard"] = build_dashboard(output_csv, lookup_locations=False, output_path=dashboard_output)
        result["dashboard_output"] = str(dashboard_output)

    result["rows"] = []
    return result


def main():
    parser = argparse.ArgumentParser(description="Query public.bullet records for a single user_id through SSH tunnel.")
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--game-type", default="FM01")
    parser.add_argument("--output-csv")
    parser.add_argument("--dashboard-output")
    args = parser.parse_args()

    result = query_user_records(args.user_id, args.game_type)
    result = enrich_result(
        result,
        output_csv=args.output_csv,
        dashboard_output=args.dashboard_output,
    )
    print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
