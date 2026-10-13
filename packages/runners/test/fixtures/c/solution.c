#include <ctype.h>
#include <stdio.h>
#include <string.h>

int add(int a, int b) {
    return a + b;
}

int count_words(const char *s) {
    int n = 0, in = 0;
    for (; *s; s++) {
        if (isspace((unsigned char)*s)) in = 0;
        else if (!in) { in = 1; n++; }
    }
    return n;
}

int divide(int a, int b) {
    return a / b;
}

int spin(void) {
    volatile unsigned long n = 0;
    for (;;) n++;
    return 0;
}

int main(void) {
    char name[100];
    if (!fgets(name, sizeof name, stdin)) return 1;
    name[strcspn(name, "\n")] = 0;
    printf("Hello, %s!\n", name);
    return 0;
}
