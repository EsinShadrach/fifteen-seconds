# Fifteen Seconds

Word lookup for timed word games. Type a letter and a length, get copy-ready words
ranked by how common they actually are.

## Use it

    words              open the page in your browser
    words e5           E-words, exactly 5 letters
    words e3+          E-words, 3 or more letters
    words e4-7         E-words, 4 to 7 letters
    words e            E-words, any length
    words str5         prefix "str", exactly 5
    words -c e5        copy the top hit straight to the clipboard
    words -n e5        first names instead of dictionary words
    words -a e5        show every match, not just the top 40

The page is also live at
https://claude.ai/code/artifact/8abb0c04-c6cb-4376-ad81-42f3f76a2eda

## Files

    index.html    the whole app - fonts and dictionary embedded, works offline
    common.txt    9,963 words in real-world frequency order (shown first)
    rest.txt      227,732 more from Webster's Second, alphabetical
    names.txt     1,306 first names

`words` lives at ~/.local/bin/words and reads the .txt files in this folder.

## Why results are ordered the way they are

common.txt comes from a usage-frequency corpus, so `e5` returns
`email every event enter early` rather than `eagre ealed eaved`. Anything from
rest.txt is dimmed in the terminal and dotted grey on the page - those are real
words, but a game may not accept them.

## Swapping in a bigger name list

names.txt is macOS's /usr/share/dict/propernames, which is small (45 names start
with E). Replace it with any newline-separated list to extend it - no rebuild
needed for the CLI. The page has its own copy baked into index.html.
