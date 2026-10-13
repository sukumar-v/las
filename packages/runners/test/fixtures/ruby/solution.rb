def add(a, b)
  a + b
end

def count_words(s)
  s.split.length
end

def divide(a, b)
  a / b
end

def spin
  loop {}
end

if __FILE__ == $PROGRAM_NAME
  name = $stdin.gets.to_s.strip
  puts "Hello, #{name}!"
end
