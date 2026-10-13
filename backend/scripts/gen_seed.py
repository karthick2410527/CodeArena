#!/usr/bin/env python3
"""Generates migrations/0002_seed_problems.sql.

Expected outputs are computed by the reference solutions below, so the seeded
test data is guaranteed consistent. Re-run with:

    python3 scripts/gen_seed.py > migrations/0002_seed_problems.sql
"""
import random
import sys
from collections import deque
from bisect import bisect_left

rng = random.Random(20240607)  # deterministic output


# ---------------------------------------------------------------- reference solutions
def sol_a_plus_b(inp):
    a, b = map(int, inp.split())
    return str(a + b)


def sol_reverse_words(inp):
    return " ".join(reversed(inp.split(" ")))


def sol_palindrome(inp):
    s = [c.lower() for c in inp if c.isalnum()]
    return "YES" if s == s[::-1] else "NO"


def sol_brackets(inp):
    pairs = {")": "(", "]": "[", "}": "{"}
    st = []
    for c in inp:
        if c in "([{":
            st.append(c)
        else:
            if not st or st.pop() != pairs[c]:
                return "NO"
    return "NO" if st else "YES"


def sol_max_subarray(inp):
    lines = inp.split("\n")
    a = list(map(int, lines[1].split()))
    best = cur = a[0]
    for x in a[1:]:
        cur = max(x, cur + x)
        best = max(best, cur)
    return str(best)


def sol_coin_change(inp):
    l = inp.split("\n")
    n, amount = map(int, l[0].split())
    coins = list(map(int, l[1].split()))
    INF = 10**9
    dp = [0] + [INF] * amount
    for v in range(1, amount + 1):
        for c in coins:
            if c <= v and dp[v - c] + 1 < dp[v]:
                dp[v] = dp[v - c] + 1
    return str(dp[amount] if dp[amount] < INF else -1)


def sol_islands(inp):
    l = inp.split("\n")
    r, c = map(int, l[0].split())
    g = [list(row) for row in l[1:1 + r]]
    seen = [[False] * c for _ in range(r)]
    count = 0
    for i in range(r):
        for j in range(c):
            if g[i][j] == "1" and not seen[i][j]:
                count += 1
                q = deque([(i, j)])
                seen[i][j] = True
                while q:
                    x, y = q.popleft()
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < r and 0 <= ny < c and g[nx][ny] == "1" and not seen[nx][ny]:
                            seen[nx][ny] = True
                            q.append((nx, ny))
    return str(count)


def sol_grid_path(inp):
    l = inp.split("\n")
    r, c = map(int, l[0].split())
    g = l[1:1 + r]
    if g[0][0] == "#" or g[r - 1][c - 1] == "#":
        return "-1"
    dist = [[-1] * c for _ in range(r)]
    dist[0][0] = 0
    q = deque([(0, 0)])
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < r and 0 <= ny < c and g[nx][ny] == "." and dist[nx][ny] == -1:
                dist[nx][ny] = dist[x][y] + 1
                q.append((nx, ny))
    return str(dist[r - 1][c - 1])


def sol_lis(inp):
    a = list(map(int, inp.split("\n")[1].split()))
    tails = []
    for x in a:
        i = bisect_left(tails, x)
        if i == len(tails):
            tails.append(x)
        else:
            tails[i] = x
    return str(len(tails))


def sol_inversions(inp):
    a = list(map(int, inp.split("\n")[1].split()))
    return str(sum(1 for i in range(len(a)) for j in range(i + 1, len(a)) if a[i] > a[j]))


# ---------------------------------------------------------------- input helpers
def arr_input(a):
    return f"{len(a)}\n{' '.join(map(str, a))}"


def grid_input(rows):
    return f"{len(rows)} {len(rows[0])}\n" + "\n".join(rows)


def random_grid(r, c, chars, weights):
    return ["".join(rng.choices(chars, weights=weights, k=c)) for _ in range(r)]


# ---------------------------------------------------------------- problem definitions
P = []

P.append(dict(
    slug="a-plus-b", title="A Plus B", difficulty="EASY", tl=1000, ml=256,
    tags=["math", "implementation"], solve=sol_a_plus_b,
    description="""Given two integers `a` and `b`, print their sum.

This is the classic first problem: read the input from standard input and write the answer to standard output.

### Input
A single line containing two space-separated integers `a` and `b`.

### Output
Print one integer: `a + b`.""",
    constraints="- `-10^9 <= a, b <= 10^9`\n- The sum may not fit in a 32-bit integer; use a 64-bit type (`long long` in C++).",
    samples=[("3 5", "3 + 5 = 8."), ("-10 4", "-10 + 4 = -6.")],
    hidden=["0 0", "1000000000 1000000000", "-1000000000 -1000000000", "123456789 -987654321"],
))

P.append(dict(
    slug="reverse-words", title="Reverse the Words", difficulty="EASY", tl=1000, ml=256,
    tags=["strings", "implementation"], solve=sol_reverse_words,
    description="""You are given a sentence made of words separated by **single spaces**. Print the same words in reverse order, still separated by single spaces.

The letters inside each word keep their original order.

### Input
One line containing the sentence.

### Output
One line containing the words in reverse order.""",
    constraints="- The sentence has between 1 and 10^5 characters.\n- Words consist of lowercase English letters.\n- There are no leading, trailing, or repeated spaces.",
    samples=[("hello world", "The two words swap places."),
             ("the quick brown fox", "Reading the words from right to left gives `fox brown quick the`.")],
    hidden=["single", "a b c d e f", "code arena is fun", "zebra apple mango"],
))

P.append(dict(
    slug="valid-palindrome", title="Valid Palindrome", difficulty="EASY", tl=1000, ml=256,
    tags=["strings", "two-pointers"], solve=sol_palindrome,
    description="""A phrase is a **palindrome** if, after removing every character that is not a letter or digit and ignoring letter case, it reads the same forwards and backwards.

Given a line of text, decide whether it is a palindrome. An empty phrase (nothing left after filtering) counts as a palindrome.

### Input
A single line of text (it may contain spaces and punctuation).

### Output
Print `YES` if the phrase is a palindrome, otherwise `NO`.""",
    constraints="- The line contains between 1 and 2 * 10^5 printable ASCII characters.",
    samples=[("A man, a plan, a canal: Panama", "Filtered and lowercased: `amanaplanacanalpanama`, which is a palindrome."),
             ("race a car", "Filtered: `raceacar`, which is not a palindrome.")],
    hidden=["No lemon, no melon", "ab", "!!!", "0P", "Was it a car or a cat I saw?"],
))

P.append(dict(
    slug="balanced-brackets", title="Balanced Brackets", difficulty="EASY", tl=1000, ml=256,
    tags=["stack", "strings"], solve=sol_brackets,
    description="""A string made only of the characters `(`, `)`, `[`, `]`, `{` and `}` is **balanced** if every opening bracket is closed by a bracket of the same type, and brackets are closed in the correct order.

### Input
A single line containing the bracket string.

### Output
Print `YES` if the string is balanced, otherwise `NO`.""",
    constraints="- The string length is between 1 and 10^5.\n- Only the six bracket characters appear.",
    samples=[("([]{})", "Every bracket is closed in the right order."),
             ("([)]", "The `[` is still open when `)` arrives, so the string is not balanced.")],
    hidden=["((((", "{[()()]}", "]", "(()", "{{[[(())]]}}"],
))

P.append(dict(
    slug="maximum-subarray-sum", title="Maximum Subarray Sum", difficulty="MEDIUM", tl=1000, ml=256,
    tags=["arrays", "dp"], solve=sol_max_subarray,
    description="""Given an array of `n` integers, find the largest possible sum of a **non-empty contiguous** subarray.

### Input
- The first line contains `n`.
- The second line contains `n` space-separated integers.

### Output
Print the maximum subarray sum.""",
    constraints="- `1 <= n <= 2 * 10^5`\n- `-10^9 <= a[i] <= 10^9`\n- Use 64-bit integers for the running sum.",
    samples=[("9\n-2 1 -3 4 -1 2 1 -5 4", "The subarray `[4, -1, 2, 1]` has sum 6."),
             ("3\n-5 -2 -9", "All numbers are negative; the best non-empty subarray is `[-2]`.")],
    hidden=[arr_input([7]), arr_input([5, 4, -1, 7, 8]),
            arr_input([rng.randint(-50, 50) for _ in range(60)]),
            arr_input([-10**9, -10**9, -1])],
))

P.append(dict(
    slug="minimum-coins", title="Minimum Coins", difficulty="MEDIUM", tl=1500, ml=256,
    tags=["dp"], solve=sol_coin_change,
    description="""You have an unlimited supply of coins in `n` different denominations. Find the **fewest coins** needed to make exactly `amount`, or report that it is impossible.

### Input
- The first line contains `n` and `amount`.
- The second line contains the `n` coin denominations.

### Output
Print the minimum number of coins, or `-1` if the amount cannot be formed.""",
    constraints="- `1 <= n <= 12`\n- `1 <= coin value <= 10^4`\n- `1 <= amount <= 10^4`",
    samples=[("3 11\n1 2 5", "`11 = 5 + 5 + 1` uses 3 coins."),
             ("1 3\n2", "Only coins of value 2 exist, so 3 can never be formed.")],
    hidden=["3 100\n1 5 10", "4 63\n1 5 10 21", "2 7\n2 4", "3 9999\n7 13 101", "1 1\n1"],
))

P.append(dict(
    slug="count-islands", title="Count the Islands", difficulty="MEDIUM", tl=1500, ml=256,
    tags=["graphs", "dfs"], solve=sol_islands,
    description="""A map is a grid of `0` (water) and `1` (land). An **island** is a maximal group of land cells connected horizontally or vertically (not diagonally).

Count the islands on the map.

### Input
- The first line contains `R` and `C`, the number of rows and columns.
- The next `R` lines each contain a string of `C` characters, each `0` or `1`.

### Output
Print the number of islands.""",
    constraints="- `1 <= R, C <= 1000`",
    samples=[("4 5\n11000\n11000\n00100\n00011", "There are three islands: the top-left block, the single middle cell, and the bottom-right pair."),
             ("1 1\n0", "No land at all.")],
    hidden=[grid_input(["101", "010", "101"]),
            grid_input(random_grid(12, 15, "01", [1, 1])),
            grid_input(["1111", "1111"]),
            grid_input(random_grid(30, 30, "01", [2, 1]))],
))

P.append(dict(
    slug="shortest-path-in-grid", title="Shortest Path in a Grid", difficulty="MEDIUM", tl=2000, ml=256,
    tags=["graphs", "bfs"], solve=sol_grid_path,
    description="""You are given a grid where `.` is an open cell and `#` is a wall. Starting at the **top-left** cell, you want to reach the **bottom-right** cell by moving one step at a time up, down, left or right through open cells.

Find the minimum number of steps, or report that the destination is unreachable. If the start or destination cell is a wall, the answer is `-1`.

### Input
- The first line contains `R` and `C`.
- The next `R` lines each contain a string of `C` characters, each `.` or `#`.

### Output
Print the minimum number of steps, or `-1`.""",
    constraints="- `1 <= R, C <= 1000`",
    samples=[("3 3\n...\n.#.\n...", "Go around the wall, e.g. right, right, down, down: 4 steps."),
             ("2 2\n.#\n#.", "Both neighbours of the start are walls.")],
    hidden=[grid_input(["."]), grid_input(["#."]), grid_input(random_grid(15, 15, ".#", [4, 1])),
            grid_input(["....", ".##.", ".#..", "...."]),
            grid_input(random_grid(25, 25, ".#", [5, 1]))],
))

P.append(dict(
    slug="longest-increasing-subsequence", title="Longest Increasing Subsequence", difficulty="MEDIUM", tl=2000, ml=256,
    tags=["dp", "binary-search"], solve=sol_lis,
    description="""Given a sequence of `n` integers, find the length of its longest **strictly increasing subsequence**. A subsequence keeps the original order but may skip elements.

### Input
- The first line contains `n`.
- The second line contains `n` space-separated integers.

### Output
Print the length of the longest strictly increasing subsequence.""",
    constraints="- `1 <= n <= 2 * 10^5`\n- `-10^9 <= a[i] <= 10^9`\n- An `O(n log n)` solution is expected.",
    samples=[("8\n10 9 2 5 3 7 101 18", "One longest subsequence is `2, 3, 7, 18`, with length 4."),
             ("5\n5 5 5 5 5", "Strictly increasing means equal values cannot repeat, so the answer is 1.")],
    hidden=[arr_input([1]), arr_input(list(range(1, 31))), arr_input(list(range(30, 0, -1))),
            arr_input([rng.randint(-100, 100) for _ in range(80)])],
))

P.append(dict(
    slug="count-inversions", title="Count Inversions", difficulty="HARD", tl=2000, ml=256,
    tags=["arrays", "divide-and-conquer"], solve=sol_inversions,
    description="""An **inversion** in an array `a` is a pair of indices `i < j` with `a[i] > a[j]`. Count the inversions of the given array.

A naive double loop is `O(n^2)` and will be too slow for the largest inputs; think divide and conquer (merge sort) or a Fenwick tree.

### Input
- The first line contains `n`.
- The second line contains `n` space-separated integers.

### Output
Print the number of inversions. The answer can exceed 32 bits.""",
    constraints="- `1 <= n <= 2 * 10^5`\n- `-10^9 <= a[i] <= 10^9`",
    samples=[("5\n2 4 1 3 5", "The inversions are `(2,1)`, `(4,1)` and `(4,3)`: 3 in total."),
             ("4\n4 3 2 1", "Every pair is inverted: 6 in total.")],
    hidden=[arr_input([1]), arr_input([1, 2, 3, 4, 5, 6]),
            arr_input([rng.randint(-10**9, 10**9) for _ in range(300)]),
            arr_input([3, 3, 3, 1, 1, 2]),
            arr_input(list(range(400, 0, -1)))],
))


# ---------------------------------------------------------------- SQL emission
def q(s):
    assert "$q$" not in s
    return f"$q${s}$q$"


def main():
    out = []
    out.append("-- Generated by scripts/gen_seed.py. Original practice problems with")
    out.append("-- public samples (is_sample = TRUE) and hidden judge data (is_sample = FALSE).")
    all_tags = sorted({t for p in P for t in p["tags"]})
    for t in all_tags:
        out.append(f"INSERT INTO tags (name) VALUES ({q(t)}) ON CONFLICT DO NOTHING;")
    for p in P:
        out.append("")
        out.append(f"-- {p['title']}")
        out.append(
            "INSERT INTO problems (slug, title, description, constraints, difficulty, time_limit_ms, memory_limit_mb, published) "
            f"VALUES ({q(p['slug'])}, {q(p['title'])}, {q(p['description'])}, {q(p['constraints'])}, "
            f"{q(p['difficulty'])}, {p['tl']}, {p['ml']}, TRUE) ON CONFLICT DO NOTHING;"
        )
        for t in p["tags"]:
            out.append(
                "INSERT INTO problem_tags (problem_id, tag_id) "
                f"SELECT p.id, t.id FROM problems p, tags t WHERE p.slug = {q(p['slug'])} AND lower(t.name) = lower({q(t)}) "
                "ON CONFLICT DO NOTHING;"
            )
        pos = 0
        for inp, expl in p["samples"]:
            pos += 1
            exp = p["solve"](inp)
            out.append(
                "INSERT INTO test_cases (problem_id, position, input, expected_output, explanation, is_sample, points) "
                f"SELECT id, {pos}, {q(inp)}, {q(exp)}, {q(expl)}, TRUE, 0 FROM problems WHERE slug = {q(p['slug'])};"
            )
        for inp in p["hidden"]:
            pos += 1
            exp = p["solve"](inp)
            out.append(
                "INSERT INTO test_cases (problem_id, position, input, expected_output, explanation, is_sample, points) "
                f"SELECT id, {pos}, {q(inp)}, {q(exp)}, NULL, FALSE, 1 FROM problems WHERE slug = {q(p['slug'])};"
            )
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
