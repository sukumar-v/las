package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func add(a, b int) int {
	return a + b
}

func countWords(s string) int {
	return len(strings.Fields(s))
}

func divide(a, b int) int {
	return a / b
}

func spin() int {
	for {
	}
}

func main() {
	name, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	fmt.Printf("Hello, %s!\n", strings.TrimSpace(name))
}
