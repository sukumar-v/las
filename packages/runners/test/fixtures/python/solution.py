import sys


def add(a, b):
    return a + b


def count_words(s):
    return len(s.split())


def divide(a, b):
    return a // b


def spin():
    while True:
        pass


if __name__ == "__main__":
    name = sys.stdin.readline().strip()
    print(f"Hello, {name}!")
