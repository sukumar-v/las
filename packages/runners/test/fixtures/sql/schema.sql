CREATE TABLE people (name TEXT, age INTEGER);
INSERT INTO people VALUES ('Ada', 36), ('Bea', 41), ('Cyd', 29);
CREATE VIEW adults_over_30 AS SELECT name FROM people WHERE age > 30 ORDER BY name;
