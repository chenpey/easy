"""EasyNews 命令入口：准备语义任务，或合并判断并导出报表。"""
import argparse
from datetime import datetime
from pathlib import Path
import sys

import news
import semantic
from export_excel import export_excel

ROOT = Path(__file__).resolve().parent.parent


def collect(output, config, options):
    checkpoint = output / "collection.json"
    if checkpoint.exists():
        saved = news.read_json(checkpoint)
        if saved["config"] != config or saved["options"] != options:
            raise ValueError("采集中断目录的配置或参数不同，请使用新目录")
        raw, sources = saved["raw"], saved["sources"]
    else:
        raw, sources = [], []
        news.write_json(checkpoint, {"config": config, "options": options, "raw": raw, "sources": sources})
    done = {s["source"] for s in sources}
    for name in options["sources"]:
        if name in done:
            continue
        records, _, status = news.crawl_source(
            name, news.SOURCES[name], config, options["max_pages"],
            options["refresh"], options["full_history"],
        )
        raw.extend(records)
        sources.append(status)
        news.write_json(checkpoint, {"config": config, "options": options, "raw": raw, "sources": sources})
    return raw, sources


def reuse(previous, config, selected):
    previous = Path(previous)
    run, _ = semantic.load_run(previous)
    prior = run["snapshot"]
    period = prior["config"]
    if not period["start"] <= config["start"] <= config["end"] <= period["end"]:
        raise ValueError("复用范围不能超出原运行日期；更大的范围需要重新采集")
    by_source = {s["source"]: s for s in prior["sources"]}
    if not set(selected) <= by_source.keys():
        raise ValueError("复用目录缺少所选栏目，请通过 --source 选择已有栏目或重新采集")
    raw = [r for r in news.read_json(previous / "raw_articles.json") if r["source"] in selected]
    return raw, [by_source[name] for name in selected]


def prepare(args):
    config = news.load_config(args.config, start=args.start, end=args.end)
    options = {
        "sources": list(dict.fromkeys(args.source or news.SOURCES)),
        "max_pages": args.max_pages, "full_history": args.full_history,
        "refresh": args.refresh, "batch_size": args.batch_size,
        "from_run": str(args.from_run.resolve()) if args.from_run else None,
    }
    if args.from_run and args.refresh:
        raise ValueError("--from-run 为离线复用，不能同时 --refresh")
    output = (args.output or ROOT / "outputs" / datetime.now().strftime("%Y%m%d_%H%M%S_%f")).resolve()
    if (output / "run.json").exists():
        run, articles = semantic.load_run(output)
        if run["snapshot"]["config"] != config or run["snapshot"]["options"] != options:
            raise ValueError("运行目录已冻结，配置或参数不同；请使用新目录")
    else:
        if output.exists() and not (output / "collection.json").exists():
            raise ValueError(f"目录已存在且不是可续跑的采集目录：{output}")
        # 离线复用也先校验输入，再创建输出目录。
        reused = reuse(args.from_run, config, options["sources"]) if args.from_run else None
        output.mkdir(parents=True, exist_ok=True)
        raw, sources = reused if reused is not None else collect(output, config, options)
        errors = {(s["source"], e["url"]): e["error"] for s in sources for e in s["errors"]}
        records = [dict(r, content_status=errors.get((r["source"], r["url"]), "已读取"))
                   for r in raw if r.get("date") and config["start"] <= r["date"] <= config["end"]]
        candidates = news.merge_articles(records)
        articles = news.coarse_filter(candidates, config["keywords"])
        snapshot = {"config": config, "options": options, "sources": sources, "candidate_count": len(candidates)}
        run = {"version": 1, "snapshot": snapshot, "run_id": semantic.fingerprint(snapshot, articles)}
        news.write_json(output / "raw_articles.json", raw)
        news.write_json(output / "coarse.json", articles)
        news.write_json(output / "run.json", run)
        (output / "collection.json").unlink(missing_ok=True)
    semantic.prepare_batches(output, run, articles)
    data, missing = semantic.merge(output)
    print_summary(data)
    print(f"运行目录：{output}")
    if missing:
        print(f"等待当前会话模型判断 {len(missing)} 个分片：{output / 'judge' / 'INSTRUCTIONS.md'}")
        print(f"判断写回后执行：uv run --locked src/easynews.py finish {output}")
    else:
        print(f"已无待判文章，可执行：uv run --locked src/easynews.py finish {output}")
    return output


def print_summary(data):
    s = data["summary"]
    print(f"区间内去重 {s['candidate_count']} -> 关键词粗筛 {s['coarse_count']} -> "
          f"符合 {s['accepted_count']} / 不符合 {s['rejected_count']} / "
          f"待确认 {s['review_count']} / 未判断 {s['pending_count']}")
    print(f"采集覆盖：{data['coverage_state']}；缺项 {s['issue_count']} 条")


def finish(args):
    data, missing = semantic.merge(args.output)
    print_summary(data)
    if missing:
        raise ValueError(f"语义判断未完成，不导出成品；待补齐：{', '.join(missing)}")
    target = args.excel or args.output / "easynews.xlsx"
    export_excel(data, target)
    print(f"统计：{args.output / 'summary.json'}")
    print(f"Excel：{target.resolve()}")
    return target


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("须为正整数")
    return number


def build_parser():
    parser = argparse.ArgumentParser(prog="easynews", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare", help="采集、粗筛并准备 AI 判断分片")
    prepare_parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    prepare_parser.add_argument("--start", help="覆盖开始日期，YYYY-MM-DD")
    prepare_parser.add_argument("--end", help="覆盖结束日期，YYYY-MM-DD")
    prepare_parser.add_argument("--output", type=Path)
    prepare_parser.add_argument("--source", action="append", choices=list(news.SOURCES))
    prepare_parser.add_argument("--max-pages", type=positive, default=300)
    prepare_parser.add_argument("--full-history", action="store_true")
    prepare_parser.add_argument("--refresh", action="store_true")
    prepare_parser.add_argument("--batch-size", type=positive, default=10)
    prepare_parser.add_argument("--from-run", type=Path, help="复用已有运行的原始正文，不联网、不复用旧判断")
    prepare_parser.set_defaults(action=prepare)

    finish_parser = commands.add_parser("finish", help="合并 AI 判断，全部完成后统计并导出 Excel")
    finish_parser.add_argument("output", type=Path)
    finish_parser.add_argument("--excel", type=Path, help="自定义导出位置，已有文件拒绝覆盖")
    finish_parser.set_defaults(action=finish)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args((sys.argv[1:] if argv is None else argv) or ["prepare"])
    try:
        return args.action(args)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f"错误：{exc}\n")


if __name__ == "__main__":
    main()
