#!/usr/bin/env bash

add() {
  echo $(( $1 + $2 ))
}

count_words() {
  local n=0
  for _ in $1; do n=$((n + 1)); done
  echo "$n"
}

divide() {
  if [ "$2" -eq 0 ]; then
    echo "division by zero" >&2
    exit 200
  fi
  echo $(( $1 / $2 ))
}

spin() {
  while :; do :; done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  read -r name
  echo "Hello, $name!"
fi
