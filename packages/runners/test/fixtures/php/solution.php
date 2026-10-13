<?php
function add($a, $b) {
    return $a + $b;
}

function count_words($s) {
    return count(preg_split('/\s+/', trim($s), -1, PREG_SPLIT_NO_EMPTY));
}

function divide($a, $b) {
    return intdiv($a, $b);
}

function spin() {
    while (true) {
    }
}

if (realpath($argv[0] ?? '') === __FILE__) {
    $name = trim(fgets(STDIN));
    echo "Hello, $name!\n";
}
