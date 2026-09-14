"""新闻采集与关键词粗筛；不执行语义判断，不导出报表。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
SOURCES = {
    "主站-热点新闻": "https://www.sues.edu.cn/26864/list.htm",
    "主站-综合新闻": "https://www.sues.edu.cn/zhxw/list.htm",
    "主站-媒体关注": "https://www.sues.edu.cn/26866/list.htm",
    "学校要闻（旧栏目）": "https://news.sues.edu.cn/13987/list.htm",
    "校园快讯（旧栏目）": "https://news.sues.edu.cn/14000/list.htm",
    "教学科研": "https://www.sues.edu.cn/xkjs/list.htm",
    "媒体聚焦（旧栏目）": "https://news.sues.edu.cn/13990/list.htm",
    "双创学院-通知公告": "https://etc.sues.edu.cn/11768/list.htm",
    "双创学院-中心新闻": "https://etc.sues.edu.cn/11769/list.htm",
    "团委-工作要讯": "https://youth.sues.edu.cn/10669/list.htm",
    "科技园-公告通知": "https://dxkjy.sues.edu.cn/ggtz/list.htm",
    "科技园-园区新闻": "https://dxkjy.sues.edu.cn/yqxw/list.htm",
}
DATE_RE = re.compile(r"(?<!\d)(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日)?(?!\d)")
DATE_SELECTORS = ".Article_PublishDate,.simpleArticlePublishDate,.column-news-date,.news_meta,.none_timer,.arti_update,.art_update,time[datetime]"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def load_config(path, **overrides):
    config = read_json(path)
    if not isinstance(config, dict):
        raise ValueError("配置须为 JSON 对象")
    config.update({key: value for key, value in overrides.items() if value is not None})
    unknown = config.keys() - {"start", "end", "topic", "keywords"}
    if unknown:
        raise ValueError("未知配置项：" + "、".join(sorted(unknown)))
    try:
        for key in ("start", "end"):
            value = config[key]
            if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
                raise ValueError(key)
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("start 和 end 须为有效日期，格式为 YYYY-MM-DD") from exc
    if config["start"] > config["end"]:
        raise ValueError("开始日期须不晚于结束日期")
    if not isinstance(config.get("topic"), str) or not config["topic"].strip():
        raise ValueError("topic 须为描述采集要求的非空文本")
    keywords = config.get("keywords")
    if not isinstance(keywords, dict) or keywords.keys() != {"title", "content"}:
        raise ValueError("keywords 须包含 title 和 content 两个关键词数组")
    for field, words in keywords.items():
        if not isinstance(words, list) or any(not isinstance(w, str) or not w.strip() for w in words):
            raise ValueError(f"keywords.{field} 须为非空字符串组成的数组")
        keywords[field] = list(dict.fromkeys(w.strip() for w in words))
    if not any(keywords.values()):
        raise ValueError("至少配置一个粗筛关键词")
    return config


def parse_date(text):
    match = DATE_RE.search(text or "")
    if match:
        try:
            return date(*map(int, match.groups())).isoformat()
        except ValueError:
            pass
    return ""


def canonical_url(url):
    p = urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("不是 HTTP(S) 链接")
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path, p.query, ""))


def article_key(url):
    p = urlsplit(url)
    match = re.search(r"c\d+a(\d+)/page.htm$", p.path)
    # 同校 WebPlus 文章 ID 跨栏目一致；不同 ID 的转载保留，避免按标题误合并。
    if p.hostname and (p.hostname == "sues.edu.cn" or p.hostname.endswith(".sues.edu.cn")) and match:
        return "sues:" + match[1]
    return canonical_url(url)


def write_json(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def fetch(url, refresh=False):
    url = canonical_url(url)
    cache = ROOT / "data" / "news_cache" / "pages"
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / (hashlib.sha256(url.encode()).hexdigest() + ".html")
    ttl = 3600 if re.search(r"/list\d*\.htm$", urlsplit(url).path) else 30 * 86400
    if not refresh and path.exists() and time.time() - path.stat().st_mtime < ttl:
        return path.read_text(encoding="utf-8")
    for attempt in range(3):
        try:
            req = Request(url, headers={"User-Agent": "EasyNews/1.0 (public academic news collector)"})
            with urlopen(req, timeout=20) as response:
                raw = response.read()
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    text = raw.decode("gb18030")
            if "<html" not in text.lower() or len(text) < 300:
                raise ValueError("响应不是有效 HTML 页面")
            temp = path.with_suffix(".tmp")
            temp.write_text(text, encoding="utf-8")
            temp.replace(path)
            time.sleep(0.15)
            return text
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def element_date(element):
    for node in element.select(DATE_SELECTORS):
        found = parse_date(node.get("datetime") or node.get_text(" ", strip=True))
        if found:
            return found
    return ""


def parse_listing(html, url):
    soup = BeautifulSoup(html, "html.parser")
    items = (soup.select(".line_news_list > li") or soup.select("ul.wp_article_list > li,a.column-news-item")
             or soup.select("li.news:has(.news_meta)") or soup.select("td.llink"))
    records, seen = [], set()
    for item in items:
        anchor = item if item.name == "a" else (item.select_one(".none_title a,.news_title a,.Article_Title a") or item.select_one("a[href]"))
        if anchor is None or not anchor.get("href"):
            continue
        try:
            link = canonical_url(urljoin(url, anchor["href"]))
        except ValueError:
            continue
        title = (anchor.get("title") or anchor.get_text(" ", strip=True)).strip()
        if title and link not in seen:
            seen.add(link)
            records.append({"title": title, "url": link, "date": element_date(item)})
    paging = soup.select_one(".wp_paging")
    if not records or not paging:
        raise ValueError("未识别新闻列表或分页，无法确认覆盖范围")
    anchor = paging.select_one("a.next[href]")
    next_url = ""
    if anchor and not anchor["href"].startswith("javascript:"):
        next_url = canonical_url(urljoin(url, anchor["href"]))
    return records, next_url


def parse_detail(html):
    soup = BeautifulSoup(html, "html.parser")
    published = element_date(soup)
    if not published:
        for meta in soup.select('meta[name="PubDate"],meta[property="article:published_time"],meta[name="publishdate"]'):
            published = parse_date(meta.get("content", ""))
            if published:
                break
    if not published:
        # 只取明确标注的发布日期，不将正文中的事件日期当作发布日期。
        for text in soup.find_all(string=re.compile(r"发布(?:时间|日期)")):
            candidate = text.parent.get_text(" ", strip=True)
            if len(candidate) < 250:
                published = parse_date(candidate)
                if published:
                    break
    body = soup.select_one(".wp_articlecontent,#vsb_content,.Article_Content,.article-content")
    content = ""
    if body:
        for node in body.select("script,style"):
            node.decompose()
        content = re.sub(r"\s+", " ", body.get_text("", strip=True)).strip()
    title = soup.select_one("h1.arti_title,.Article_Title,.article-title")
    return {"date": published, "content": content, "title": title.get_text(" ", strip=True) if title else ""}


def crawl_source(name, url, config, max_pages=300, refresh=False, full_history=False):
    start, end = config["start"], config["end"]
    status = {"source": name, "url": url, "pages": 0, "checked": 0, "candidates": 0, "matched": 0,
              "latest": "", "earliest": "", "state": "采集中", "stop": "", "errors": []}
    raw, results, seen, visited = [], [], set(), set()
    old_pages = 0

    def enrich(item):
        record = dict(item, source=name, date_source="列表" if item["date"] else "", content="")
        if item["date"] and not start <= item["date"] <= end:
            return record, ""
        try:
            detail = parse_detail(fetch(item["url"], refresh))
            if detail["date"]:
                if record["date"] and record["date"] != detail["date"]:
                    record["date_note"] = "列表日期 " + record["date"] + "；采用详情页发布日期"
                record["date"], record["date_source"] = detail["date"], "详情页"
            if detail["title"]:
                record["title"] = detail["title"]
            record["content"] = detail["content"]
            if not record["date"]:
                return record, "未识别发布日期"
            if start <= record["date"] <= end and not record["content"]:
                return record, "未识别正文（可能为图片或外链文章）"
            return record, ""
        except Exception as exc:
            return record, str(exc)

    with ThreadPoolExecutor(max_workers=4) as pool:
        while url and status["pages"] < max_pages:
            if url in visited:
                status["errors"].append({"url": url, "error": "分页循环"})
                break
            visited.add(url)
            try:
                items, next_url = parse_listing(fetch(url, refresh), url)
            except Exception as exc:
                status["errors"].append({"url": url, "error": str(exc)})
                break
            status["pages"] += 1
            fresh = []
            for item in items:
                key = article_key(item["url"])
                if key not in seen:
                    fresh.append(item)
                    seen.add(key)
            page_dates = []
            for record, error in pool.map(enrich, fresh):
                status["checked"] += 1
                raw.append(record)
                page_dates.append(record["date"])
                if record["date"]:
                    status["latest"] = max(status["latest"], record["date"])
                    status["earliest"] = min(status["earliest"] or record["date"], record["date"])
                if error:
                    status["errors"].append({"url": record["url"], "error": error})
                if record["date"] and start <= record["date"] <= end:
                    results.append(dict(record, content_status=error or "已读取"))
            status["candidates"] = len(results)
            print(f"{name}：第 {status['pages']} 页，检查 {status['checked']} 篇，区间内 {len(results)} 篇", flush=True)
            if page_dates and not any(page_dates):
                status["stop"] = "整页发布日期缺失，需修复解析后重试"
                status["errors"].append({"url": url, "error": status["stop"]})
                break
            # 假设栏目大体倒序；严格历史审计用 full_history。
            known_dates = [d for d in page_dates if d]
            old_pages = old_pages + 1 if known_dates and len(known_dates) >= len(page_dates) / 2 and all(d < start for d in known_dates) else 0
            if old_pages >= 2 and not full_history:
                status["stop"] = "连续两页有效日期早于区间；缺日期另列"
                break
            if not fresh and next_url:
                status["errors"].append({"url": url, "error": "整页重复，无法确认后续内容"})
                break
            url = next_url
        else:
            status["stop"] = "栏目末页" if not url else "达到页数上限"
            if url:
                status["errors"].append({"url": url, "error": "达到页数上限，尚未完成"})
    status["state"] = "存在缺项" if status["errors"] else "已完成当前栏目扫描"
    return raw, results, status


def merge_articles(records):
    merged = {}
    for record in records:
        key = article_key(record["url"])
        if key not in merged:
            merged[key] = dict(record, id=key, sources=[record["source"]], links=[record["url"]])
        else:
            current = merged[key]
            if not current.get("content") and record.get("content"):
                current.update(record)
            for plural, singular in [("sources", "source"), ("links", "url")]:
                if record[singular] not in current[plural]:
                    current[plural].append(record[singular])
    return sorted(merged.values(), key=lambda r: (r["date"], r["title"]), reverse=True)


def coarse_filter(articles, keywords):
    """任一关键词命中即保留；content 在标题和正文中匹配，不做语义排除。"""
    kept = []
    for article in articles:
        title = article.get("title", "")
        body = title + "\n" + article.get("content", "")
        hits = {
            "title": [word for word in keywords["title"] if word.casefold() in title.casefold()],
            "content": [word for word in keywords["content"] if word.casefold() in body.casefold()],
        }
        if any(hits.values()):
            kept.append(dict(article, keyword_hits=hits))
    return kept
